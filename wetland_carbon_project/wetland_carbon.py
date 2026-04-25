########################################################################################################################
# wetland_carbon.py
# Author: James Jin (cjjin)
# Purpose: Calculates change in carbon storage in wetland soil based on LULC changes.
#          Primarily designed to be run through an ArcGIS Pro custom tool.
########################################################################################################################

import arcpy, sys, os, csv
from arcpy.sa import *
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import textwrap
import datetime

def project_and_clip_rast(in_rast, out_rast, spat_ref, bound):
    """Project and clip a raster"""
    # clip the raster by the projected boundary
    desc = arcpy.Describe(in_rast)
    desc_sr = desc.spatialReference

    try:
        arcpy.management.Project(bound, "boundary_proj", desc_sr)
    except arcpy.ExecuteError:
        raise arcpy.ExecuteError(f"Error projecting boundary. Potential error in spatial reference for {in_rast}")
    rast_mask = ExtractByMask(in_rast, "boundary_proj")
    rast_mask.save("temp_rast")

    arcpy.management.ProjectRaster("temp_rast", out_rast, spat_ref)
    arcpy.management.Delete("boundary_proj")
    arcpy.management.Delete("temp_rast")

def generate_hbar_graph(table_dict, pdf_file, title, xlabel, ylabel):
    """Generates bar graphs for carbon stock and vegetation type results"""
    cat = []
    carbon_lost = []
    for veg_type in table_dict:
        cat.append(veg_type)
        carbon_lost.append(table_dict[veg_type][0] - table_dict[veg_type][1])

    wrapped_labels = [textwrap.fill(label, width=15) for label in cat]

    plt.figure(figsize=(10, 15))

    bars = plt.barh(wrapped_labels, carbon_lost)

    plt.subplots_adjust(left=0.2)
    plt.xlabel(xlabel)
    plt.ylabel(ylabel)
    plt.yticks(fontsize=8)
    plt.title(title)

    max_val = max(carbon_lost)

    for bar in bars:
        width = bar.get_width()
        y = bar.get_y() + bar.get_height() / 2

        label = f"{width:,.0f}"

        if width > max_val * 0.1:
            plt.text(width - max_val * 0.02, y, label,
                        va='center', ha='right', color='white', fontsize=8)

        else:
            plt.text(width + max_val * 0.01, y, label,
                        va='center', ha='left', color='black', fontsize=8)

    pdf_file.savefig()
    plt.close()

class WetlandCarbonAnalyzer:

    def __init__(self,
                 boundary,
                 wetland_carbon,
                 nlcd,
                 open_water_conv,
                 dev_conv,
                 barren_conv,
                 agri_conv,
                 evt,
                 watersheds,
                 out_dir,
                 proj_and_clip=True
        ):
        self.sr = arcpy.SpatialReference(5070)
        self.boundary = boundary
        self.wetland_carbon = wetland_carbon
        self.nlcd = nlcd

        self.open_water_conv = float(open_water_conv)
        self.dev_conv = float(dev_conv)
        self.barren_conv = float(barren_conv)
        self.agri_conv = float(agri_conv)

        self.evt = evt
        self.watershed_list = watersheds
        if len(watersheds) == 1 and watersheds[0] == "#":
            self.watershed_list = []
        self.out_dir = out_dir
        if out_dir.endswith(".gdb"):
            raise arcpy.ExecuteError("A File GDB has been used as the output directory. Input a directory instead.")
        if not os.path.isdir(out_dir):
            raise arcpy.ExecuteError("The output directory is not a directory. Input a directory instead.")
        if not os.path.exists(out_dir):
            arcpy.AddMessage(f"{out_dir} does not exist. Creating...")
            os.makedirs(out_dir)
        self.out_files = os.path.join(self.out_dir, "output_files")
        os.makedirs(self.out_files, exist_ok=True)
        self.workspace = str(os.path.join(self.out_dir, os.path.basename(self.out_dir) + ".gdb"))
        if not arcpy.Exists(self.workspace):
            arcpy.management.CreateFileGDB(self.out_dir, os.path.basename(self.out_dir) + ".gdb")
        self.proj_and_clip = proj_and_clip

        arcpy.env.workspace = self.workspace
        arcpy.env.overwriteOutput = True
        arcpy.env.parallelProcessingFactor = "50%"
        arcpy.env.pyramid = "NONE"
        arcpy.env.rasterStatistics = "NONE"

        self.carbon_rast = None
        self.nlcd_rast = None
        self.evt_rast = None

        self.nlcd_carbon = None

        self.table_wetland_carbon = {}
        self.table_sbcls_carbon = {}
        self.table_watersheds_carbon = {}

        if self.evt != "#":
            # EVT_NAME: numeric ID
            self.id_dict = {}

            with arcpy.da.SearchCursor(self.evt, ["VALUE", "EVT_NAME"]) as sc:
                for row in sc:
                    self.id_dict[row[1]] = row[0]

    def get_carbon_rasters(self):
        """Creates a raster of estimated carbon in the year the nlcd data was recorded"""
        arcpy.AddMessage("Calculating carbon lost.")
        # get raster of carbon in 2024
        # assume carbon stayed the same since 2011
        self.nlcd_carbon = Con(
            (self.nlcd_rast == 90) | (self.nlcd_rast == 95) | ((self.nlcd_rast > 40) & (self.nlcd_rast < 80)),
            self.carbon_rast
        )
        if arcpy.Exists("nlcd_carbon"):
            arcpy.management.Delete("nlcd_carbon")

        # get raster of wetlands lost with soil carbon data
        # multiply the 2011 carbon value with a value based on which land cover class the pixel was converted to
        carbon_lost = SetNull(
            (self.nlcd_rast == 90) | (self.nlcd_rast == 95) | ((self.nlcd_rast > 40) & (self.nlcd_rast < 80)),
            self.carbon_rast
        )
        wetlands_lost = Con(~IsNull(carbon_lost), self.nlcd_rast)

        #get estimated carbon stock remaining based on nlcd class conversions
        carbon_adjusted = carbon_lost

        # open water
        carbon_adjusted = Con(
            (wetlands_lost == 11) | (wetlands_lost == 12),
            carbon_lost * (1 - self.open_water_conv),
            carbon_adjusted
        )
        # developed
        carbon_adjusted = Con(
            (wetlands_lost >= 21) & (wetlands_lost <= 24),
            carbon_lost * (1 - self.dev_conv),
            carbon_adjusted
        )
        # barren
        carbon_adjusted = Con(
            wetlands_lost == 31,
            carbon_lost * (1 - self.barren_conv),
            carbon_adjusted
        )
        # agriculture
        carbon_adjusted = Con(
            (wetlands_lost == 81) | (wetlands_lost == 82),
            carbon_lost * (1 - self.agri_conv),
            carbon_adjusted
        )

        # combine carbon from unchanged wetlands and estimated remaining carbon
        self.nlcd_carbon = Con(IsNull(self.nlcd_carbon), carbon_adjusted, self.nlcd_carbon)
        self.nlcd_carbon.save("nlcd_carbon")
        self.nlcd_carbon = Raster("nlcd_carbon")

        arcpy.management.ClearWorkspaceCache()
        del carbon_adjusted

        #get estimated carbon stock lost based on nlcd class conversions
        # create a NoData raster as the starting point
        est_carbon_lost = SetNull(wetlands_lost >= 0, wetlands_lost)
        # open water
        est_carbon_lost = Con(
            (wetlands_lost == 11) | (wetlands_lost == 12),
            carbon_lost * self.open_water_conv,
            est_carbon_lost
        )
        # developed
        est_carbon_lost = Con(
            (wetlands_lost >= 21) & (wetlands_lost <= 24),
            carbon_lost * self.dev_conv,
            est_carbon_lost
        )
        # barren
        est_carbon_lost = Con(
            wetlands_lost == 31,
            carbon_lost * self.barren_conv,
            est_carbon_lost
        )
        # agriculture
        est_carbon_lost = Con(
            (wetlands_lost == 81) | (wetlands_lost == 82),
            carbon_lost * self.agri_conv,
            est_carbon_lost
        )
        #remove pixels with unchanged carbon stock
        if arcpy.Exists("carbon_lost"):
            arcpy.management.Delete("carbon_lost")
        est_carbon_lost.save("carbon_lost")
        arcpy.management.ClearWorkspaceCache()
        del est_carbon_lost
        del carbon_lost
        del wetlands_lost

    def get_zonal_statistics(self, zone_field, table_dict):
        """Retrieve zonal statistcs for vegetation types and carbon stocks for both time periods"""
        ZonalStatisticsAsTable(
            self.evt_rast,
            zone_field,
            self.carbon_rast,
            f"carbon_by_evt_{zone_field}_before",
            "DATA",
            "SUM"
        )
        ZonalStatisticsAsTable(
            self.evt_rast,
            zone_field,
            self.nlcd_carbon,
            f"carbon_by_evt_{zone_field}_after",
            "DATA",
            "SUM"
        )

        fields = [zone_field, "SUM"]

        with arcpy.da.SearchCursor(f"carbon_by_evt_{zone_field}_before", fields) as sc:
            for row in sc:
                if zone_field == "EVT_NAME":
                    table_dict[row[0]] = (self.id_dict[row[0]], row[1], 0)
                else:
                    table_dict[row[0]] = (row[1], 0)

        with arcpy.da.SearchCursor(f"carbon_by_evt_{zone_field}_after", fields) as sc:
            for row in sc:
                if row[0] in table_dict:
                    if zone_field == "EVT_NAME":
                        before = table_dict[row[0]][1]
                        table_dict[row[0]] = (self.id_dict[row[0]], before, row[1])
                    else:
                        before = table_dict[row[0]][0]
                        table_dict[row[0]] = (before, row[1])
                else:
                    if zone_field == "EVT_NAME":
                        table_dict[row[0]] = (self.id_dict[row[0]], 0, row[1])
                    else:
                        table_dict[row[0]] = (0, row[1])

    def zonal_statistics_by_watersheds(self):
        """Calculate the zonal statistics by watersheds for carbon stock loss"""
        # project watersheds and boundary fc
        proj_watersheds = []
        for watershed_fc in self.watershed_list:
            arcpy.management.Project(watershed_fc, os.path.basename(watershed_fc).split(".")[0], self.sr)
            proj_watersheds.append(os.path.basename(watershed_fc).split(".")[0])
        arcpy.management.Project(self.boundary, os.path.basename(self.boundary).split(".")[0], self.sr)

        # merge watersheds and clip by fc
        fc_for_clip = proj_watersheds[0]
        if len(proj_watersheds) > 1:
            fc_for_clip = "watersheds_merge"
            arcpy.management.Merge(proj_watersheds, fc_for_clip)
        arcpy.analysis.Clip(
            fc_for_clip,
            os.path.basename(self.boundary).split(".")[0],
            "watersheds"
        )

        huc_field = arcpy.ListFields("watersheds", "huc*")
        if len(arcpy.ListFields("watersheds", "name")) == 0 and len(huc_field) == 0:
            arcpy.AddWarning("Watershed feature class does not have proper fields (\"name\" or \"huc##\"). " +
                             "Skipping watershed analysis.")
            return ""
        field_to_use = "name"
        for field in huc_field:
            try:
                int(field.name[3:])
                if len(field.name) > 5:
                    raise ValueError
                field_to_use = field.name
            except ValueError:
                pass
        if field_to_use =="name":
            arcpy.AddWarning("Invalid huc field name, using \"name\" as the zone field.")

        try:
            arcpy.conversion.PolygonToRaster(
                "watersheds",
                field_to_use,
                "watersheds_rast",
                cellsize=self.wetland_carbon
            )
        except arcpy.ExecuteError:
            arcpy.AddWarning("Invalid watershed datasets.")

            for watershed_fc in self.watershed_list:
                arcpy.management.Delete(os.path.basename(watershed_fc).split(".")[0])
            arcpy.management.Delete(os.path.basename(self.boundary).split(".")[0])
            arcpy.management.Delete(fc_for_clip)
            arcpy.management.Delete("watersheds")

            return ""

        ZonalStatisticsAsTable(
            "watersheds_rast",
            field_to_use,
            self.carbon_rast,
            "carbon_by_watersheds_before",
            "DATA",
            "SUM"
        )
        ZonalStatisticsAsTable(
            "watersheds_rast",
            field_to_use,
            self.nlcd_carbon,
            "carbon_by_watersheds_after",
            "DATA",
            "SUM"
        )

        fields = [field_to_use, "SUM"]

        with arcpy.da.SearchCursor("carbon_by_watersheds_before", fields) as sc:
            for row in sc:
                self.table_watersheds_carbon[row[0]] = (row[1], 0)

        with arcpy.da.SearchCursor("carbon_by_watersheds_after", fields) as sc:
            for row in sc:
                if row[0] in self.table_watersheds_carbon:
                    before = self.table_watersheds_carbon[row[0]][0]
                    self.table_watersheds_carbon[row[0]] = (before, row[1])
                else:
                    self.table_watersheds_carbon[row[0]] = (0, row[1])

        for watershed_fc in self.watershed_list:
            arcpy.management.Delete(os.path.basename(watershed_fc).split(".")[0])
        arcpy.management.Delete(os.path.basename(self.boundary).split(".")[0])
        arcpy.management.Delete(fc_for_clip)
        arcpy.management.Delete("watersheds")

        return field_to_use

    def print_zonal_statistics_to_csv(self, out_csv, zone_field, table_dict):
        """Prints the zonal statistics to a csv file"""
        csv_file = os.path.join(self.out_files, out_csv)
        csv_out = open(csv_file, "w+", newline="\n")
        csv_writer = csv.writer(csv_out)

        if zone_field == "EVT_NAME":
            csv_writer.writerow(
                [zone_field,
                 "Numeric ID",
                 "Starting Carbon Stock (metric tons C)",
                 "Ending Carbon Stock (metric tons C)",
                 "Carbon Lost (metric tons C)"]
            )
            for zone in table_dict:
                d_tuple = table_dict[zone]
                numeric_id = d_tuple[0]
                #convert to tons of carbon
                #multiply by 900 to get carbon per pixel
                #divide by 1000000 for g to metric tons
                c_start = d_tuple[1] * 900 / 1000000
                c_end = d_tuple[2] * 900 / 1000000
                c_lost = c_start - c_end
                csv_writer.writerow([zone, numeric_id, c_start, c_end, c_lost])
        else:
            csv_writer.writerow(
                [zone_field,
                 "Starting Carbon Stock (metric tons C)",
                 "Ending Carbon Stock (metric tons C)",
                 "Carbon Lost (metric tons C)"]
            )
            for zone in table_dict:
                d_tuple = table_dict[zone]
                # convert to tons of carbon
                # multiply by 900 to get carbon per pixel
                # divide by 1000000 for g to metric tons
                c_start = d_tuple[0] * 900 / 1000000
                c_end = d_tuple[1] * 900 / 1000000
                c_lost = c_start - c_end
                csv_writer.writerow([zone, c_start, c_end, c_lost])

        csv_out.close()

    def add_to_map(self):
        """Add the resulting estimated carbon layer to the map."""
        proj_file = arcpy.mp.ArcGISProject("CURRENT")
        m = proj_file.activeMap

        for layer in m.listLayers():
            if not layer.isBasemapLayer:
                m.removeLayer(layer)

        #set symbology for original carbon stock
        og_carbon_path = os.path.join(self.workspace, "carbon_stock")
        arcpy.management.CalculateStatistics(og_carbon_path)
        arcpy.management.BuildPyramids(og_carbon_path)
        m.addDataFromPath(og_carbon_path)

        #set symbology for carbon in after period
        nlcd_carbon_path = os.path.join(self.workspace, "nlcd_carbon")
        m.addDataFromPath(nlcd_carbon_path)

        #set symbology for carbon lost
        carbon_lost_path = os.path.join(self.workspace, "carbon_lost")
        m.addDataFromPath(carbon_lost_path)
        layer = m.listLayers("carbon_lost")[0]
        sym = layer.symbology
        ramps = proj_file.listColorRamps("Yellow to Red")
        sym.colorizer.colorRamp = ramps[0]
        layer.symbology = sym

    def process(self):
        arcpy.CheckOutExtension("Spatial")

        if self.proj_and_clip:
            # project and clip rasters
            arcpy.AddMessage("Projecting and clipping rasters.")
            project_and_clip_rast(self.wetland_carbon, "carbon_stock", self.sr, self.boundary)
            project_and_clip_rast(self.nlcd, "land_cover", self.sr, self.boundary)
            if self.evt != "#":
                project_and_clip_rast(self.evt, "veg_type", self.sr, self.boundary)
                self.evt = "veg_type"
            self.wetland_carbon = "carbon_stock"
            self.nlcd = "land_cover"
        else:
            arcpy.AddMessage("Skipping projection and clipping.")

        #create raster objects for rasters after projection
        self.carbon_rast = arcpy.Raster(self.wetland_carbon)
        self.nlcd_rast = arcpy.Raster(self.nlcd)

        #run analysis
        self.get_carbon_rasters()
        arcpy.AddMessage("Calculating zonal statistics.")
        if self.evt != "#":
            self.evt_rast = arcpy.Raster(self.evt)
            self.get_zonal_statistics("EVT_NAME", self.table_wetland_carbon)
            self.get_zonal_statistics("EVT_SBCLS", self.table_sbcls_carbon)
            table_name = "carbon_by_evt_name.csv"
            table_sbcls = "carbon_by_evt_sbcls.csv"
            self.print_zonal_statistics_to_csv(table_name, "EVT_NAME", self.table_wetland_carbon)
            self.print_zonal_statistics_to_csv(table_sbcls, "EVT_SBCLS", self.table_sbcls_carbon)

            pdf_file = PdfPages(os.path.join(self.out_files, "carbon_zonal_graphs.pdf"))
            # generate_hbar_graph(
            #     self.table_wetland_carbon,
            #     pdf_file,
            #     "Carbon stock loss per vegetation subclass",
            #     "Carbon stock loss (metric tons of C)",
            #     "Vegetation type"
            # )
            generate_hbar_graph(
                self.table_sbcls_carbon,
                pdf_file,
                "Carbon stock loss per vegetation subclass",
                "Carbon stock loss (metric tons of C)",
                "Vegetation type"
            )
            pdf_file.close()
        if len(self.watershed_list) != 0:
            f = self.zonal_statistics_by_watersheds()
            if f:
                table_watershed = "carbon_by_watersheds.csv"
                self.print_zonal_statistics_to_csv(table_watershed, f, self.table_watersheds_carbon)
                # pdf_file = PdfPages(os.path.join(self.out_files, "carbon_by_watersheds_graphs.pdf"))
                # generate_hbar_graph(
                #     self.table_watersheds_carbon,
                #     pdf_file,
                #     "Carbon stock loss per watershed",
                #     "Carbon stock loss",
                #     "Watershed"
                # )
                # pdf_file.close()

        del self.nlcd_carbon
        del self.carbon_rast
        del self.nlcd_rast
        del self.evt_rast

        #add to map
        try:
            self.add_to_map()
        except OSError:
            pass

        arcpy.AddMessage(f"Analysis complete. Results found in {self.workspace}")
        arcpy.CheckInExtension("Spatial")
        arcpy.management.ClearWorkspaceCache()

def main():
    start_time = datetime.datetime.now()

    # get inputs
    study_area = sys.argv[1]
    w_carbon = sys.argv[2]
    lulc = sys.argv[3]
    open_water_conv = sys.argv[4]
    dev_conv = sys.argv[5]
    barren_conv = sys.argv[6]
    agri_conv = sys.argv[7]
    lf_evt = sys.argv[8]
    watersheds = sys.argv[9].split(";")
    reproject = sys.argv[10]
    out_dir = sys.argv[11]

    if reproject.lower() == "true":
        reproject = True
    else:
        reproject = False

    wca = WetlandCarbonAnalyzer(
        study_area,
        w_carbon,
        lulc,
        open_water_conv,
        dev_conv,
        barren_conv,
        agri_conv,
        lf_evt,
        watersheds,
        out_dir,
        reproject
    )
    wca.process()

    end_time = datetime.datetime.now()
    elapsed_time = end_time - start_time

    # Print the runtime
    print(f"Script runtime: {elapsed_time}")

if __name__ == "__main__":
    main()