/**
 * WetlandCarbonAnalyzer
 * Author: James Jin (cjjin)
 * Purpose: Calculates change in carbon storage in wetland soil based on LULC changes.
 */

//IMPORTANT: toggle true and false to switch between exporting to drive and generating download URLs.
//For web applications, only the download URLs will work.
var export_to_drive = false;

//uploaded 2011 CONUS full mean carbon stock data
//replace with path to own uploaded carbon data in assets
var carbon_stock_CONUS = ee.Image("projects/ee-cjjin/assets/CONUS_Full_Stock_Mean");

var panel = ui.Panel({
  style: {width: "340px"}
});

//-----Title and Description-----
//Title text
panel.add(
  ui.Label({
    value: "Estimating Wetland Carbon Storage Change", 
    style: {
      fontSize: '18px',
    fontWeight: 'bold'
    }
  })
);

//description text
panel.add(ui.Label("This tool estimates the carbon stored in wetlands from 2011 carbon stock data. " + 
  "It uses land cover data from a given year and calculates carbon change based on land cover changes. " + 
  "The result is estimated carbon stored and carbon lost for the given year compared to 2011. " + 
  "To start, select a boundary and set the conversion factors (defaults are already set), then " + 
  "click the 'Run Analysis' button."));

panel.add(ui.Label("Recommended use is for smaller study areas. While states and polygons of any size can be used, " + 
  "some functions such as the table or the inspector may take a long time to load or simply won't work properly if the study area " + 
  "is too large. Similarly, the size of the download will be limited. Data for entire states will not be available for download."));

var ug_url = "https://drive.google.com/file/d/1rjisgO8AhOyR2GVtl3KVUz9ic7Dl2MvN/view?usp=sharing"
var ug_link = ui.Label({
  value: 'User Guide',
  style: {color: 'blue'},
  targetUrl: ug_url
});
panel.add(ug_link);

//-----------------------------------------------State selection-----------------------------------------------

//variables defined early so can be used in multiple places
var drawingTools = Map.drawingTools();
//reset polygon drawing
drawingTools.stop();
drawingTools.layers().reset();
drawingTools.setShown(false);
var use_drawn_polygon = false;
var using_state = false;
var study_geom;

panel.add(
  ui.Label({
    value: "Select a State for Study Area Or Draw a Polygon", 
    style: {
      fontSize: '14px',
    fontWeight: 'bold'
    }
  })
);

var states = ee.FeatureCollection("TIGER/2018/States");
// Filter to CONUS (exclude AK and HI)
var conusStates = states.filter(ee.Filter.inList("STUSPS", [
  "AL","AZ","AR","CA","CO","CT","DE","FL","GA","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA",
  "MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
]));

//Get state names for drop down menu
var stateNames = conusStates.aggregate_array("NAME").getInfo();
stateNames.sort();

//Create drop down menu to select state
var state_select = ui.Select({
  items: stateNames,
  placeholder: "Select a state (CONUS only)",
  onChange: function(state_name) {
    Map.layers().reset();
    if (!state_name) {
      return;
    }
    var state = conusStates.filter(ee.Filter.eq('NAME', state_name)).first();
    study_geom = state.geometry();
    Map.centerObject(study_geom, 7);
    
    //reset polygon drawing
    drawingTools.stop();
    drawingTools.layers().reset();
    drawingTools.setShown(false);
    
    use_drawn_polygon = false;
    using_state = true;
    
    var outline = ee.FeatureCollection([ee.Feature(study_geom)]).style({
      color: 'black',
      width: 2,
      fillColor: '00000000'
    });
    
    Map.addLayer(outline);
  }
});
panel.add(state_select);
panel.add(ui.Label("--------OR--------"));

//-----------------------------------------------Polygon Drawing-----------------------------------------------

//button for drawing polygon for study area
var draw_button = ui.Button({
  label: 'Draw Polygon',
  onClick: function() {
    Map.layers().reset();
    drawingTools.stop();
    drawingTools.layers().reset();
    drawingTools.setShown(true);
    drawingTools.setDrawModes(["polygon"]);
    drawingTools.setShape("polygon");
    drawingTools.onDraw(function(geometry) {
      study_geom = geometry;
    });
    drawingTools.draw();
    
    //reset state select
    if (study_geom) {
      state_select.setValue(null);
    }
    
    use_drawn_polygon = true;
    using_state = false;
  }
});

panel.add(draw_button);

//-----------------------------------------------Year Selection-----------------------------------------------
panel.add(
  ui.Label({
    value: "Select a Year for NLCD Input (Post-2011)", 
    style: {
      fontSize: '14px',
    fontWeight: 'bold'
    }
  })
);

//default 2024 NLCD data
//replace with path to own uploaded 2024 NLCD in assets
var nlcd_CONUS = ee.Image("projects/ee-cjjin/assets/NLCD_LndCov_2024");
//year options
var years = ["2013", "2016", "2019", "2021", "2024"];

var sel_year = 2024;
var year_select = ui.Select({
  items: years,
  value: "2024",
  placeholder: "Select a year (post-2011)",
  onChange: function(year) {
    //use the proper NLCD data based on year
    if (year == "2024") {
      //replace with path to own uploaded 2024 NLCD in assets
      nlcd_CONUS = ee.Image("projects/ee-cjjin/assets/NLCD_LndCov_2024");
    } else if (year == "2021") {
      nlcd_CONUS = ee.ImageCollection("USGS/NLCD_RELEASES/2021_REL/NLCD").select("landcover").first();
    }  else {
      var nlcd_2019 = ee.ImageCollection("USGS/NLCD_RELEASES/2019_REL/NLCD").select("landcover");
      nlcd_CONUS = nlcd_2019.filter(ee.Filter.eq("system:index", year)).first();
    }
    sel_year = year;
  }
});
panel.add(year_select);

//-----------------------------------------------Conversion Factors-----------------------------------------------
//conversions from wetland to other land cover classes
var open_water_Box = ui.Textbox({
  value: "0.2",
  placeholder: '0 - 1'
});
var dev_Box = ui.Textbox({
  value: "0.6",
  placeholder: '0 - 1'
});
var barren_Box = ui.Textbox({
  value: "0.4",
  placeholder: '0 - 1'
});
var agri_Box = ui.Textbox({
  value: "0.2",
  placeholder: '0 - 1'
});

//add textboxes and labels
panel.add(
  ui.Label({
    value: "Conversion Factors (must be between 0 and 1)", 
    style: {
      fontSize: '14px',
    fontWeight: 'bold'
    }
  })
);
panel.add(ui.Label("Wetland -> Open Water Conversion Factor"));
panel.add(open_water_Box);
panel.add(ui.Label("Wetland -> Developed Conversion Factor"));
panel.add(dev_Box);
panel.add(ui.Label("Wetland -> Barren Conversion Factor"));
panel.add(barren_Box);
panel.add(ui.Label("Wetland -> Agriculture Conversion Factor"));
panel.add(agri_Box);

//-----------------------------------------------Sum Results Table-----------------------------------------------
var table_panel = ui.Panel({
  style: {
    position: "bottom-left",
    height: "170px",
    width: "400px",
    padding: "8px"
  }
});

Map.add(table_panel);

table_panel.add(ui.Label("Carbon in Wetland Soil Sums (metric tons of C)"));

//put results in feature collection
var fc = ee.FeatureCollection([
  ee.Feature(null, {Metric: "Total Carbon in 2011", Carbon: ""}),
  ee.Feature(null, {Metric: "Total Estimated Remaining Carbon", Carbon: ""}),
  ee.Feature(null, {Metric: "Total Estimated Carbon Loss", Carbon: ""})
]);
  
//create table and add to panel
var table_chart = ui.Chart.feature.byFeature(fc, "Metric", "Carbon").setChartType('Table');
table_panel.add(table_chart);

//-----------------------------------------------Download Button-----------------------------------------------
var wetland_carbon_rast;
var nlcd_carbon_rast;
var est_carbon_lost_rast;

var dl_panel = ui.Panel({
  style: {
    position: "bottom-left",
    padding: "8px"
  }
});

Map.add(dl_panel);

var download_button = ui.Button({
  label: "Download Raster Datasets",
  style: {
    width: "200px",
    height: "50px",
    fontSize: "12px",
    fontWeight: "bold"
  },
  onClick: function() {
    dl_panel.clear();
    var wc_url = null;
    var nc_url = null;
    var ecl_url = null;
    var num_complete = 0;
    
    /*
     * Checks if the URL process is done. If so, executes checks for valid URLs.
     * Adds to download panel the proper response.
     */
    function check_done() {
      num_complete++;
      
      if (num_complete < 3) {
        return;
      }
      if (!wc_url || !nc_url || !ecl_url) {
        dl_panel.add(ui.Label("Failed to create download links. Raster datasets are likely too large. Use a smaller study area."));
        dl_panel.add(ui.Label("Refer to the Download section of the code for how to get larger datasets."));
        return;
      }
      
      var ecl_link = ui.Label({
        value: 'Download Estimated Carbon Loss',
        style: {color: 'blue'},
        targetUrl: ecl_url
      });
      dl_panel.add(ecl_link);
    
      var nc_link = ui.Label({
        value: 'Download Estimated Carbon Stored in ' + sel_year,
        style: {color: 'blue'},
        targetUrl: ecl_url
      });
      dl_panel.add(nc_link);
    
      var wc_link = ui.Label({
        value: 'Download Wetland Carbon in 2011',
        style: {color: 'blue'},
        targetUrl: wc_url
      });
      dl_panel.add(wc_link);
    }
    
    if (export_to_drive) {
      dl_panel.add(ui.Label("Check 'Tasks' in GEE Code Editor to export to Google Drive."));
      Export.image.toDrive({
        image: wetland_carbon_rast,
        description: "carbon_in_2011", //change this
        folder: "GEE_Exports", //change this
        fileNamePrefix: "c_2011", //file name
        region: study_geom,
        scale: 30,
        crs: 'EPSG:5070',
        maxPixels: 1e13
      });
      Export.image.toDrive({
        image: nlcd_carbon_rast,
        description: "estimated_carbon_remaining_" + sel_year, //change this
        folder: "GEE_Exports", //change this
        fileNamePrefix: "est_c_rem_" + sel_year, //file name
        region: study_geom,
        scale: 30,
        crs: 'EPSG:5070',
        maxPixels: 1e13
      });
      Export.image.toDrive({
        image: est_carbon_lost_rast,
        description: "estimated_carbon_lost_" + sel_year, //change this
        folder: "GEE_Exports", //change this
        fileNamePrefix: "est_c_lost_" + sel_year, //file name
        region: study_geom,
        scale: 30,
        crs: 'EPSG:5070',
        maxPixels: 1e13
      });
    } else {
      //retrieve download urls, check if there are any errors when creating the url
      wetland_carbon_rast.getDownloadURL({
        name: "wetland_carbon_2011",
        scale: 30,
        region: study_geom,
        fileFormat: "GeoTIFF"
      }, function(url, err) {
        if (!err) {
          wc_url = url;
        }
        check_done();
      });
      nlcd_carbon_rast.getDownloadURL({
        name: "estimated_carbon_" + sel_year,
        scale: 30,
        region: study_geom,
        fileFormat: "GeoTIFF"
      }, function(url, err) {
        if (!err) {
          nc_url = url;
        }
        check_done();
      });
      est_carbon_lost_rast.getDownloadURL({
        name: "estimated_carbon_loss_from_2011_to_" + sel_year,
        scale: 30,
        region: study_geom,
        fileFormat: "GeoTIFF"
      }, function(url, err) {
        if (!err) {
          ecl_url = url;
        }
        check_done();
      });
    }
  }
});

//-----------------------------------------------Legend-----------------------------------------------
//create legend panel
var legend = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px 15px'
  }
});

//title
var legendTitle = ui.Label({
  value: 'Carbon (g C/m²)',
  style: {fontWeight: 'bold', fontSize: '14px'}
});
legend.add(legendTitle);

//color bars
var y_r_palette = ['#ffffb2','#fecc5c','#fd8d3c','#f03b20','#bd0026']; //yellow to red
var b_w_palette = ['#000000', '#666666', '#999999', '#cccccc', '#ffffff']; //black to white
legend.add(make_color_bar(y_r_palette));
legend.add(make_color_bar(b_w_palette));

//labels
var legendLabels = ui.Panel({
  widgets: [
    ui.Label('0'),
    ui.Label({
      value: '60000',
      style: {textAlign: 'right', stretch: 'horizontal'}
    })
  ],
  layout: ui.Panel.Layout.flow('horizontal')
});
legend.add(legendLabels);

Map.add(legend);

//-----------------------------------------------Inspect Pixel-----------------------------------------------
var current_rasters = null;

var inspector = ui.Panel({
  style: {
    position: "bottom-right",
    padding: "8px"
  }
});
Map.add(inspector);
inspector.add(ui.Label("Click on a pixel to inspect data"));

var inspect_count = 0;
//click handler for inspector
Map.onClick(function(coords) {
  if (!current_rasters) {
    return;
  }
  inspector.clear();
  inspector.add(ui.Label("Loading..."));

  var point = ee.Geometry.Point(coords.lon, coords.lat);

  //retrieve data at pixel
  var c_lost = current_rasters.cl.sample({
    region: point,
    scale: 30,
    numPixels: 1
  }).first();
  var c_rem = current_rasters.nlcd.sample({
    region: point,
    scale: 30,
    numPixels: 1
  }).first();
  var c_2011 = current_rasters.wc.sample({
    region: point,
    scale: 30,
    numPixels: 1
  }).first();
      
  inspector.clear();
  //get and print data at pixel
  var inspect1;
  var inspect2;
  var inspect3;
  c_lost.evaluate(function(result1) {
    if (result1) {
      var val = result1.properties[Object.keys(result1.properties)[0]];
      inspect1 = "Carbon Lost: " + val + " g C/m²";
    } else {
      inspect1 = "Carbon Lost: No data";
    }
    c_rem.evaluate(function(result2) {
      if (result2) {
        var val = result2.properties[Object.keys(result2.properties)[0]];
        inspect2 = "Carbon Remaining: " + val + " g C/m²";
      } else {
        inspect2 = "Carbon Remaining: No data";
      }
      c_2011.evaluate(function(result3) {
        if (result3) {
          var val = result3.properties[Object.keys(result3.properties)[0]];
          inspect3 = "Carbon in 2011: " + val + " g C/m²";
        } else {
          inspect3 = "Carbon in 2011: No data";
        }
        if (inspect1 && inspect2 && inspect3) {
          inspect_count++;
          inspector.add(ui.Label("-----Pixel Inspect Count " + inspect_count + "-----"));
          inspector.add(ui.Label(inspect1));
          inspector.add(ui.Label(inspect2));
          inspector.add(ui.Label(inspect3));
        }
      });
    });
  });
});
//-----------------------------------------------Check Box-----------------------------------------------
var vis_checked = false;

var check_box = ui.Checkbox({
  label: "Visualize without aggregation? Only check for smaller study areas. " +
    "May cause issues with larger or statewide study areas",
  value: false
});

check_box.onChange(function(checked) {
  vis_checked = checked;
  if (vis_checked && using_state) {
    alert("Are you sure you want to visualize without aggregation? Using statewide study areas is very likely to cause memory issues.");
  }
});

panel.add(check_box);

//-----------------------------------------------Analysis Button-----------------------------------------------
var first_run = true;
var button = ui.Button({
  label: "Run Analysis",
  style: {
    width: "200px",
    height: "50px",
    fontSize: "12px",
    fontWeight: "bold"
  },
  onClick: function() {
    //clear download panel
    dl_panel.clear();
    
    //reset map
    Map.layers().reset();
    
    //check if a geometry for study area has been provided
    if (!study_geom) {
      alert("Please select a state or draw a polygon.");
      return;
    }
    //drawn polygon size limit (in km^2)
    if (!export_to_drive && use_drawn_polygon && study_geom.area().divide(1e6).getInfo() > 50000) {
      alert("Drawn polygon's area is too large (> 50,000 km^2). Please redraw.");
      Map.layers().reset();
      drawingTools.stop();
      drawingTools.layers().reset();
      return;
    }
    
    //remove all existing layers
    Map.layers().reset();
    
    //read and validate factors
    var open_water_conv = validate_factor(open_water_Box.getValue());
    var dev_conv = validate_factor(dev_Box.getValue());
    var barren_conv = validate_factor(barren_Box.getValue());
    var agri_conv = validate_factor(agri_Box.getValue());
    
    //check if any conversion factors are invalid
    if (open_water_conv == -1 || dev_conv == -1 || barren_conv == -1 || agri_conv == -1) {
      alert("Invalid conversion factor(s). Must be a numeric value between 0 and 1.");
      return;
    }
    
    //run analysis
    var rast_arr = calculate_carbon_change(study_geom, open_water_conv, dev_conv, barren_conv, agri_conv);
    wetland_carbon_rast = rast_arr[0];
    nlcd_carbon_rast = rast_arr[1];
    est_carbon_lost_rast = rast_arr[2];
    
    //deactivate drawn polygon
    drawingTools.stop();
    drawingTools.layers().reset();
    drawingTools.setShown(false);
    
    if (first_run) {
      panel.add(download_button);
    }
    first_run = false;
    
    current_rasters = {
      cl: est_carbon_lost_rast,
      nlcd: nlcd_carbon_rast,
      wc: wetland_carbon_rast
    };
    
    //get sum of carbon in 2011
    var total_carbon_start = wetland_carbon_rast.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: study_geom,
      scale: 30,
      maxPixels: 1e12
    }).get("b1");
    //get remaining carbon
    var remaining_carbon = nlcd_carbon_rast.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: study_geom,
      scale: 30,
      maxPixels: 1e12
    }).get("b1");
    //calculate lost carbon
    var lost_carbon = ee.Number(total_carbon_start).subtract(remaining_carbon);
    
    //convert to kg C/m²
    var scaled_tcs = ee.Number(total_carbon_start).divide(1000000).multiply(900).round();
    var scaled_rc = ee.Number(remaining_carbon).divide(1000000).multiply(900).round();
    var scaled_lc = lost_carbon.divide(1000000).multiply(900).round();
    
    //clear off panel
    table_panel.clear();
    table_panel.add(ui.Label("Carbon in Wetland Soil Sums (metric tons of C)"));
    //put results in feature collection
    var fc = ee.FeatureCollection([
      ee.Feature(null, {Metric: "Total Carbon in 2011", Carbon: scaled_tcs}),
      ee.Feature(null, {Metric: "Total Estimated Remaining Carbon", Carbon: scaled_rc}),
      ee.Feature(null, {Metric: "Total Estimated Carbon Loss", Carbon: scaled_lc})
    ]);
  
    //create table and add to panel
    var table_chart = ui.Chart.feature.byFeature(fc, "Metric", "Carbon").setChartType('Table');
    table_panel.add(table_chart);
  }
});
panel.add(button);

//add panel to map
ui.root.insert(0, panel);
Map.setCenter(-95, 40, 5);

//-----------------------------------------------Functions-----------------------------------------------

/**
 * Checks if the conversion factor input is a valid float between 0 and 1
 * 
 * @param {string} c_factor - conversion factor as string
 * @return {float} ret_factor - conversion factor as float, or -1 if invalid
 */
function validate_factor(c_factor) {
  for (var i = 0; i < c_factor.length; i++) {
    if (/[^0-9.]/g.test(c_factor[i])) {
      return -1;
    }
  }
  var ret_factor = parseFloat(c_factor);
  if (ret_factor < 0 || ret_factor > 1) {
    return -1;
  }
  return ret_factor;
}

/**
 * Creates a color bar for the legend
 * 
 * @param {array} palette - palette for colorbar
 * @return {ui.Thumbnail} thumbnail for colorbar
 */
function make_color_bar(palette) {
  return ui.Thumbnail({
    image: ee.Image.pixelLonLat().select(0),
    params: {
      bbox: [0, 0, 1, 0.1],
      dimensions: '100x10',
      format: 'png',
      min: 0,
      max: 1,
      palette: palette
    },
    style: {stretch: 'horizontal', margin: '8px 0'}
  });
}

/**
 * Estimates the carbon stored in wetlands using changes in land cover data based on previous wetland carbon stock data.
 * Adds previous carbon stock, estimated remaining carbon stock, and carbon loss to the map.
 * 
 * @param {ee.Geometry} boundary - Boundary for clipping raster datasets
 * @param {float} ow_conv - wetland to open water conversion factor
 * @param {float} d_conv - wetland to developed conversion factor
 * @param {float} b_conv - wetland to barren conversion factor
 * @param {float} a_conv - wetland to agriculture water conversion factor
 * @return {array} array of raster outputs
 */
function calculate_carbon_change(boundary, ow_conv, d_conv, b_conv, a_conv) {
  //Clip carbon and NLCD to boundary
  var wetland_carbon = carbon_stock_CONUS.clip(boundary);
  var nlcd = nlcd_CONUS.clip(boundary);

  //Get carbon raster without pixels where nlcd changed to land cover that loses carbon
  var wetland_mask = nlcd.eq(90).or(nlcd.eq(95)).or(nlcd.gt(40).and(nlcd.lt(80)));
  var nlcd_carbon = wetland_carbon.updateMask(wetland_mask);

  //Get carbon cells and nlcd cells were loss occurs
  var carbon_lost = wetland_carbon.updateMask(wetland_mask.not());
  var wetlands_lost = nlcd.updateMask(wetland_mask.not());

  //Adjust the lost carbon to find remaining carbon based on conversion factors
  var carbon_adjusted = carbon_lost;

  //Open water
  carbon_adjusted = carbon_adjusted.where(
    wetlands_lost.eq(11).or(wetlands_lost.eq(12)),
    carbon_lost.multiply(1 - ow_conv)
  );

  //Developed
  carbon_adjusted = carbon_adjusted.where(
    wetlands_lost.gte(21).and(wetlands_lost.lte(24)),
    carbon_lost.multiply(1 - d_conv)
  );

  //Barren
  carbon_adjusted = carbon_adjusted.where(
    wetlands_lost.eq(31),
    carbon_lost.multiply(1 - b_conv)
  );

  //Agriculture
  carbon_adjusted = carbon_adjusted.where(
    wetlands_lost.eq(81).or(wetlands_lost.eq(82)),
    carbon_lost.multiply(1 - a_conv)
  );

  //Combine carbon from unchanged wetladns and estimated reamining carbon
  nlcd_carbon = nlcd_carbon.unmask(carbon_adjusted);

  //Calculate lost carbon on conversion factors for visualization purposes
  var est_carbon_lost = carbon_lost;

  //Open water
  est_carbon_lost = est_carbon_lost.where(
    wetlands_lost.eq(11).or(wetlands_lost.eq(12)),
    carbon_lost.multiply(ow_conv)
  );

  //Developed
  est_carbon_lost = est_carbon_lost.where(
    wetlands_lost.gte(21).and(wetlands_lost.lte(24)),
    carbon_lost.multiply(d_conv)
  );

  //Barren
  est_carbon_lost = est_carbon_lost.where(
    wetlands_lost.eq(31),
    carbon_lost.multiply(b_conv)
  );

  //Agriculture
  est_carbon_lost = est_carbon_lost.where(
    wetlands_lost.eq(81).or(wetlands_lost.eq(82)),
    carbon_lost.multiply(a_conv)
  );

  if (vis_checked) {
    //slower but more accurate visualization
    Map.addLayer(
      wetland_carbon.reproject({
        crs: wetland_carbon.projection(),
        scale: 30
      }), 
      {min: 0, max: 60000, palette: ['#000000', '#666666', '#999999', '#cccccc', '#ffffff']}, 
      "Carbon in 2011", 
      false
    );
    Map.addLayer(
      nlcd_carbon.reproject({
        crs: nlcd_carbon.projection(),
        scale: 30
      }), 
      {min: 0, max: 60000, palette: ['#000000', '#666666', '#999999', '#cccccc', '#ffffff']}, 
      "Estimated Carbon in " + sel_year
    );
    Map.addLayer(
      est_carbon_lost.reproject({
        crs: est_carbon_lost.projection(),
        scale: 30
      }), 
      {min: 0, max: 60000, palette: ['#ffffb2','#fecc5c','#fd8d3c','#f03b20','#bd0026']}, 
      "Estimated Carbon Loss"
    );
  } else {
      //Faster but visualization is less accurate
    Map.addLayer(
      wetland_carbon, 
      {min: 0, max: 60000, palette: ['#000000', '#666666', '#999999', '#cccccc', '#ffffff']}, 
      "Carbon in 2011", 
      false
    );
    Map.addLayer(
      nlcd_carbon, 
      {min: 0, max: 60000, palette: ['#000000', '#666666', '#999999', '#cccccc', '#ffffff']}, 
      "Estimated Carbon in " + sel_year
    );
    Map.addLayer(
      est_carbon_lost, 
      {min: 0, max: 60000, palette: ['#ffffb2','#fecc5c','#fd8d3c','#f03b20','#bd0026']}, 
      "Estimated Carbon Loss"
    );
  }
  
  return [wetland_carbon, nlcd_carbon, est_carbon_lost];
}