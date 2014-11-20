var system = require("system");
var fs = require("fs");
var utils = require('./utils');
var md5 = require("./md5");
var logger = require('./logger');
var config = require('./config').loadConfig().fetchController;
var scheduleUrl = config.scheduleUrl + "/" + config.scheduleCount;

var ForwardHeaders = ['Server', 'Content-Type', 'Content-Language', 'X-Powered-By',
                      'Location',
                      'Set-Cookie', 'Vary', 'Date',
                      'X-Cache', 'X-Cache-Lookup',
                      'Cache-Control', 'Last-Modified', 'Expires'];

var ExitWait = 20;

/**
 * The process exit when served page number exceed this number
 * */
var MaxServedPage = 200;

/**
 * The max wait time to ask for tasks
 * */
var MaxSchedulePeriod = 60;

var quit = false;

var satellite = {

    status : "ready",

    round : 0,

    roundInterval : null,

    roundTick : 0,

    exitTick : 0,

    schedulePeriod : 1, // in seconds

    servedPages : 0,

    /**
     * Start the satellite client system
     * */
    run : function() {
        // tick every second
        this.roundInterval = setInterval(function() {
            ++satellite.roundTick;

            // exit the satellite fetcher system
            if (quit) {
                if (++satellite.exitTick > ExitWait) {
                    phantom.exit(0);
                }
                else if (satellite.exitTick % 5) {
                	logger.info("waiting for exit...");
                }
            }

            // start the fetch cycle
            var schedule = (satellite.roundTick % satellite.schedulePeriod == 0);

//            logger.debug('quit : ' + quit
//            		+ ', status : ' + satellite.status
//            		+ ', schedule : ' + schedule 
//            		+ ', period' + satellite.schedulePeriod);

            if (!quit && satellite.status == "ready" && schedule) {
                ++satellite.round;

                satellite.schedule(scheduleUrl);
            }
        }, 1000);
    },

    /**
     * ask for tasks and fetch the target web page
     * */
    schedule : function (scheduleUrl) {
        var page = require('webpage').create();

        page.open(scheduleUrl, function (status) {
            if (status !== 'success') {
                logger.info("failed to ask tasks");

                satellite.__adjustSchedulePeriod(true);

                page.close();
                satellite.status = "ready";
                return;
            }

            satellite.status = "scheduled";

            var fetchItems = JSON.parse(page.plainText);

            // release resource
            page.close();

            if (fetchItems.length == 0) {
                satellite.__adjustSchedulePeriod(true);
                satellite.status = "ready";
            }
            else {
                satellite.__adjustSchedulePeriod(false);

                logger.debug("round " + satellite.round + ", task " + fetchItems[0].itemID
                		+ ", " + fetchItems[0].url);

                // fetch the desired web page
                satellite.fetch(fetchItems[0]);
            }
        });
    },

    /**
     * Download the target web page, ask for all ajax content if necessary
     * 
     * TODO : 
     * 1. We may need to ask tasks from and commit the job back to the slave nutch slaves
     * 2. Sniff nested page lists, for example, comments for a product
     * comments for a specified product might be very large and can be separated into pages
     * */
    fetch : function(fetchItem) {
    	// logger.debug("fetch item id : " + fetchItem.itemID + ", url : " + fetchItem.url);

        var start = new Date().getTime();
        this.status = "fetching";

        var fetcher = require('./fetcher').create();
        fetcher.fetch(fetchItem.url, config, function(response, page) {
            if (!page) {
                logger.error("page is closed, skip...");

                satellite.status = "ready";

                return;
            }

            satellite.status = "fetched";

            var elapsed = new Date().getTime() - start; // in milliseconds

            // satellite information
            var username = config.username;
            var password = config.password;
            password = md5.hex_md5(password); // TODO : add a piece of salt
            // TODO : compress content and optimization
            var content = page.content.replace(/gbk|gb2312|big5|gb18030/gi, 'utf-8');

            var customHeaders = {
                'Q-Version' : 0.80,
                'Q-Username' : username,
                'Q-Password' : password,
                'Q-Queue-ID' : fetchItem.queueID,
                'Q-Item-ID' : fetchItem.itemID,
                'Q-Status-Code' : response.status,
                'Q-Checksum' : md5.hex_md5(content),
                'Q-Url' : fetchItem.url,
                'Q-Response-Time' : elapsed
            };

            // forwarded information
            // for every forwarded header, add a F- prefix
            for (var i = 0; i < response.headers.length; ++i) {
                var name = response.headers[i].name;
                var value = response.headers[i].value;

                if (ForwardHeaders.indexOf(name) !== -1) {
                    // nutch seeks a "\n\t" or "\n " as a line continue mark
                    // but it seems that some response header use only '\n' for a line continue mark
                    value = value.replace(/\n\t*/g, "\n\t");
                    if (name == 'Content-Type') {
                        // the content encoding is utf-8 now for all pages
                        value = value.replace(/gbk|gb2312|big5|gb18030/gi, 'utf-8');
                    }

                    customHeaders["F-" + name] = value;
                }
            }

            if (page) {
            	page.close();
            	page = null;
            }

            satellite.submit(customHeaders, content);
        });
    },

    /**
     * Upload the fetch result to the fetch server
     * */
    submit: function (customHeaders, content) {
        var page = require('webpage').create();
        page.customHeaders = customHeaders;
        var settings = {
            operation : "PUT",
            encoding : "utf8",
        	headers : {
        		"Content-Type" : "text/html; charset=utf-8"
        	},
            data : content
        };
		page.onResourceRequested = function(requestData, networkRequest) {
        	// logger.debug(JSON.stringify(requestData));
		};
        page.open(config.submitUrl, settings, function (status) {
            if (status !== 'success') {
                logger.error('FAIL to submit, status : ' + status + ', result : ' + page.content);
            }
            else {
            	logger.debug('submitted ' + customHeaders['Q-Url']);
            }

            // for debug
            var file = utils.getTemporaryFile(customHeaders['Q-Url']);
            fs.write(file, page.content, 'w');

            satellite.status = "ready";

            // stop satellite periodically to ensure all resource released correctly
            // the coordinator will restart the satellite
            if (++satellite.servedPages >= MaxServedPage) {
                satellite.stop();

                // communication with the coordinator
                system.stderr.write('terminate');
            }

            page.close();
        });
    },

    /**
     * Stop this satellite client process
     * */
    stop : function() {
        // it seems phantomjs can not recycle resource correctly
        // give the process a chance to recycle resources
        // the process will be restarted by coordinator
        quit = true;

        clearInterval(this.roundInterval);
    },

    /**
     * If no tasks, wait for a longer period, but no longer than 30 seconds
     * */
    __adjustSchedulePeriod : function(adjust) {
        if (adjust) {
            this.schedulePeriod *= 2;
            if (this.schedulePeriod > MaxSchedulePeriod) {
                this.schedulePeriod = MaxSchedulePeriod;
            }
        }
        else {
            this.schedulePeriod = 1;
        }
    }
};

satellite.run();
