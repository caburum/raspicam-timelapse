'use strict';

const http = require('http');
const httpShutdownExtend = require('http-shutdown');
const urlModule = require('url');
const querystring = require('querystring');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');
const st = require('st');
const crypto = require('crypto');
const ExifImage = require('exif').ExifImage;
// const vcgencmd = require('vcgencmd');
const vcgencmd = {
	getCamera: () => {
		return { detected: true };
	},
	measureTemp: () => NaN,
};
const diskusage = require('diskusage');

const configFilename = __dirname + '/config.json';
var config = {
	isCapturing: false,
	captureDaemonPid: null,
	capturePath: '/home/pi/capture',
	captureFolder: 'default',
	timelapseInterval: 10,
	exposure: 'auto',
	ev: 0,
	iso: 100,
	shutterSpeed: 'auto',
	awb: 'auto',
	awbRedGain: 'auto',
	awbBlueGain: 'auto',
	hflip: false,
	vflip: false,
	width: 1920,
	height: 1080,
	thumbnailWidth: 1280/2,
	thumbnailHeight: 720/2,
	jpegQuality: 100,
};

function loadConfig() {
	try {
		var savedConfig = fs.readFileSync(configFilename, 'utf8');
		savedConfig = JSON.parse(savedConfig);

		if (savedConfig) {
			for (var name in savedConfig) {
				if (typeof config[name] !== 'undefined') {
					config[name] = savedConfig[name];
				}
			}
		}
	} catch (err) {
		// ignore config errors - we start with default config
	}
}

loadConfig();

function saveConfig(callback) {
	fs.writeFile(configFilename, JSON.stringify(config, null, '\t'), callback);
}

var mounts = [
	st({
		// path: __dirname + '/../capture',
		path: config.capturePath, // fixme: update when path changed in ui
		// specify cache:false to turn off caching entirely
		cache: {
			fd: {
				max: 1000, // number of fd's to hang on to
				maxAge: 1000 * 60 * 60,
			},
			stat: {
				max: 5000, // number of stat objects to hang on to
				maxAge: 1000 * 60,
			},
			content: {
				max: 1024 * 1024 * 64, // how much memory to use on caching contents
				maxAge: 1000 * 60 * 10,
				cacheControl: 'public, max-age=600',
			},
			index: {
				max: 1024 * 8, // how many bytes of autoindex html to cache
				maxAge: 1000 * 60,
			},
			readdir: {
				max: 1000, // how many dir entries to cache
				maxAge: 1000 * 60,
			},
		},
		url: '/capture/',
		index: true,
		autoindex: true,
		passthrough: true,
	}),
	st({
		path: __dirname + '/webapp',
		index: 'index.html',
		passthrough: true,
	}),
];

var previewImage = null;
var previewImageName = null;
var previewImageHash = null;
var previewImageInfo = null;

function updatePreviewImage() {
	previewImageName = config.capturePath + '/latest.jpg';

	function onError(err) {
		previewImage = null;
		previewImageHash = null;
		previewImageInfo = null;
	}

	fs.stat(previewImageName, function (err, stat) {
		if (err) return onError(err);

		var newHash = crypto
			.createHash('md5')
			.update('' + stat.mtime + '#' + stat.size)
			.digest('hex');

		if (newHash === previewImageHash) return;

		try {
			new ExifImage({ image: previewImageName }, function (err, exifData) {
				if (err) return onError(err);

				fs.open(previewImageName, 'r', function (err, fd) {
					if (err) return onError(err);

					var offset = exifData.thumbnail.ThumbnailOffset + 12; // see https://github.com/gomfunkel/node-exif/issues/31
					var length = exifData.thumbnail.ThumbnailLength;
					var thumbnail = new Buffer(length);

					fs.read(fd, thumbnail, 0, length, offset, function (err) {
						fs.close(fd);
						if (err) return onError(err);

						// Thumbnail is padded to 24KB by raspistill - remove 0x00 bytes at the end:
						var length = thumbnail.length;
						while (length > 0 && thumbnail[length - 1] === 0) length--;
						thumbnail = thumbnail.slice(0, length);

						previewImage = thumbnail;
						previewImageHash = newHash;
						previewImageInfo = formatDate(stat.mtime) + ' (' + formatBytes(stat.size) + ')';
					});
				});
			});
		} catch (err) {
			onError(err);
		}
	});
}

var updatePreviewImageInterval = setInterval(updatePreviewImage, 1000);
updatePreviewImage();

var status = {
	isCapturing: false,
	latestPictureHash: null,
	captureMode: { title: 'Capture mode', value: 'unknown', type: 'default' },
	latestPicture: { title: 'Latest picture', value: 'unknown', type: 'default' },
	freeDiskSpace: { title: 'Free disk space', value: 'unknown', type: 'default' },
	cpuTemp: { title: 'CPU temperature', value: 'unknown', type: 'default' },
	systemLoad: { title: 'System load', value: 'unknown', type: 'default' },
	uptime: { title: 'Uptime', value: 'unknown', type: 'default' },
};

var cameraDetected = vcgencmd.getCamera().detected;

/** @param partial {boolean} skip longer updates */
function updateStatus(partial) {
	status.isCapturing = config.isCapturing;
	status.latestPictureHash = previewImageHash;

	status.latestPicture.value = previewImage ? previewImageInfo : '(none)';
	status.latestPicture.type = previewImage ? 'success' : 'danger';

	if (!partial) cameraDetected = vcgencmd.getCamera().detected;

	if (!cameraDetected) {
		status.captureMode.value = 'No camera detected';
		status.captureMode.type = 'danger';
	} else if (!isDaemonRunning()) {
		status.captureMode.value = 'Not capturing (' + (config.isCapturing ? 'but should' : 'good') + '), daemon not running';
		status.captureMode.type = 'danger';
	} else if (!config.isCapturing) {
		status.captureMode.value = 'Daemon running but shouldn\'t';
		status.captureMode.type = 'warning';
	} else {
		status.captureMode.value = 'Capturing (' + (config.captureDaemonPid !== null ? 'PID ' + config.captureDaemonPid : 'No active process!') + ')';
		status.captureMode.type = config.captureDaemonPid !== null ? 'success' : 'warning';
	}

	if (!partial) {
		fs.stat('/', function (err2, sdStat) {
			fs.stat(config.capturePath, function (err1, captureStat) {
				diskusage.check('/', function (err4, sdInfo) {
					diskusage.check(config.capturePath, function (err3, captureInfo) {
						if (err1 || err2 || err3 || err4) {
							status.freeDiskSpace.value = 'error';
							status.freeDiskSpace.type = 'danger';
							return;
						}

						var sdFreePercent = Math.round((sdInfo.available / sdInfo.total) * 1000) / 10;
						var captureFreePercent = Math.round((captureInfo.available / captureInfo.total) * 1000) / 10;
						var minFreePercent = Math.min(sdFreePercent, captureFreePercent);
						status.freeDiskSpace.value = 'SD-Card: ' + formatBytes(sdInfo.available) + ' (' + sdFreePercent + ' %)';
						if (captureStat.dev !== sdStat.dev) {
							status.freeDiskSpace.value += ' - Capture: ' + formatBytes(captureInfo.available) + ' (' + captureFreePercent + ' %)';
						}
						status.freeDiskSpace.type = minFreePercent < 10 ? (minFreePercent < 3 ? 'danger' : 'warning') : 'success';
					});
				});
			});
		});

		var cpuTemp = vcgencmd.measureTemp();
		status.cpuTemp.value = '' + cpuTemp + ' °C';
		status.cpuTemp.type = cpuTemp >= 65 ? (cpuTemp >= 75 ? 'danger' : 'warning') : 'success';
	}

	var systemLoad = os.loadavg();
	status.systemLoad.value = systemLoad
		.map(function (load) {
			return load.toFixed(2);
		})
		.join(', ');
	status.systemLoad.type = systemLoad[0] >= 2 ? (systemLoad[0] >= 5 ? 'danger' : 'warning') : 'success';

	var uptime = os.uptime();
	// var duration = new Intl.DurationFormat('en-US', { style: 'narrow', units: ['day', 'hour', 'minute', 'second'] }).format(uptime * 1000);
	var days = Math.floor(uptime / (3600 * 24));
	uptime -= days * (3600 * 24);
	var hours = Math.floor(uptime / 3600);
	uptime -= hours * 3600;
	var minutes = Math.floor(uptime / 60);
	uptime -= minutes * 60;
	var seconds = Math.floor(uptime);
	status.uptime.value = (days > 0 ? days + 'd ' : '') + pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
}

var updateStatusInterval = setInterval(updateStatus, 10000);
updateStatus();

function formatDate(date) {
	return pad2(date.getFullYear()) + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function pad2(number) {
	if (number < 10) return '0' + number;
	return '' + number;
}

function formatBytes(bytes) {
	var unit = 'B',
		units = ['KB', 'MB', 'GB'];

	for (var i = 0; i < units.length; i++) {
		if (bytes < 1024) break;
		bytes /= 1024;
		unit = units[i];
	}
	return bytes.toFixed(2) + ' ' + unit;
}

function generateDaemonArguments() {
	var raspistillOptions = {
		width: config.width,
		height: config.height,
		encoding: 'jpg',
		quality: config.jpegQuality,
		thumb: config.thumbnailWidth + ':' + config.thumbnailHeight + ':70',
		output: config.capturePath + '/' + config.captureFolder + '/img_%04d.jpg',
		latest: config.capturePath + '/latest.jpg',

		exposure: config.exposure,
		ev: config.ev != 0 ? config.ev : undefined,
		ISO: config.iso,
		shutter: config.shutterSpeed !== 'auto' ? Math.round((1 / config.shutterSpeed) * 1000000) : undefined,
		awb: config.awb,
		awbgains: config.awbRedGain !== 'auto' && config.awbBlueGain !== 'auto' ? config.awbRedGain + ',' + config.awbBlueGain : undefined,
		hflip: config.hflip ? null : undefined,
		vflip: config.vflip ? null : undefined,

		timelapse: Math.round(config.timelapseInterval * 1000),
		timeout: 10 * 365 * 24 * 3600,
		verbose: null,
	};

	var raspistillOptionsRaw = [];
	for (var name in raspistillOptions) {
		if (typeof raspistillOptions[name] === 'undefined') continue;
		raspistillOptionsRaw.push('--' + name);
		if (raspistillOptions[name] !== null) {
			raspistillOptionsRaw.push('' + raspistillOptions[name]);
		}
	}

	return raspistillOptionsRaw;
}

/** @returns {boolean} */
function isDaemonRunning() {
	try {
		// const stdout = child_process.execSync('ps -aef | grep "raspistill" | grep "\\-\\-timelapse"');
		// return stdout.toString().split('\n').length > 0;

		const stdout = child_process.execSync('systemctl is-active --user timelapse-raspistill');
		console.log(`daemon status '${stdout}'`);
		return stdout.trim() == 'active';
	} catch (e) {
		// console.error(e);
		return false;
	}
}

var apiActions = {
	startCapture: function (data, callback) {
		if (/*config.captureDaemonPid !== null &&*/ isDaemonRunning()) return callback('Capture daemon already running', 400);

		config.isCapturing = true;
		config.captureFolder = formatDate(new Date()).replace(/:/g, '.');

		fs.mkdir(config.capturePath + '/' + config.captureFolder, function (err) {
			if (err) return callback('Error creating capture folder');

			var arg = generateDaemonArguments().map(s => s.startsWith('--') ? s : (`'` + s.replace(/'/g, `'"'`) + `'`)).join(' ');
			fs.writeFile('/tmp/timelapse-raspistill-env', 'RASPISTILL_ARGS=' + arg, function(err) {
				if (err) return callback('Error creating service env file');

				// var child = child_process.spawn('/usr/bin/raspistill', generateDaemonArguments(), {
				// 	cwd: config.capturePath,
				// 	stdio: 'ignore',
				// 	detached: true,
				// });
				// console.log('created child process', child, child.pid);
				// config.captureDaemonPid = child.pid;
				// child.unref();

				try {
					var cmd = '/usr/bin/systemctl restart --user timelapse-raspistill';
					console.log('cmd', cmd);
					child_process.exec(cmd);
				} catch (err) {
					return callback('Error starting service, ' + err);
				}

				saveConfig(function (err) {
					if (err) return callback('Error saving config');
					updateStatus(true);
					callback(status, 200);
				});
			});
		});
	},
	stopCapture: function (data, callback) {
		config.isCapturing = false;

		if (/*config.captureDaemonPid !== null ||*/ isDaemonRunning()) {
			/*try {
				try {
					process.kill(config.captureDaemonPid, 'SIGKILL');
					config.captureDaemonPid = null;
				} catch (err2) {
					console.log('stop, trying to kill all');
					child_process.execSync('pkill -f raspistill');
				}
			} catch (err) {
				console.error(err);
				callback({ error: err.message }, 500);
			}*/
			child_process.exec('systemctl stop --user timelapse-raspistill');
		}

		saveConfig(function (err) {
			if (err) return callback('Error saving config');
			updateStatus(true);
			callback(status, 200);
		});
	},
	loadStatus: function (data, callback) {
		updateStatus(true);
		callback(status, 200);
	},
	loadConfig: function (data, callback) {
		callback(config, 200);
	},
	saveConfig: function (newConfig, callback) {
		for (var name in newConfig) {
			if (typeof config[name] !== 'undefined') {
				config[name] = newConfig[name];
			}
		}

		saveConfig(function (err) {
			if (err) return callback({ error: 'Error saving config' }, 500);
			callback(config, 200);
		});
	},
	unknown: function (data, callback) {
		callback({ error: 'Unknown API-Action' }, 404);
	},
};

/*if (config.captureDaemonPid !== null) {
	// check if process still exists:
	try {
		console.log('checking process', config.captureDaemonPid);
		process.kill(config.captureDaemonPid, 0);
	} catch (err) {
		console.log('process not alive');
		config.captureDaemonPid = null;
		try {
			child_process.execSync('pkill -f raspistill');
		} catch (err) {
			console.log('error killing all', err);
		}
	}
}*/
if (config.isCapturing) {
	apiActions['startCapture']({}, function () {});
} else {
	child_process.exec('systemctl stop --user timelapse-raspistill');
}

var server = http.createServer((request, response) => {
	var startTime = process.hrtime();

	var url = urlModule.parse(request.url);

	if (url.pathname === '/api') {
		var query = querystring.parse(url.query);
		var action = query.action;

		if (request.method === 'POST') {
			var body = '';
			request.on('data', function (data) {
				body += data;
				if (body.length > 65536) request.connection.destroy();
			});
			request.on('end', function () {
				try {
					var requestData = JSON.parse(body);
					if (typeof requestData !== 'object') throw new Error();
				} catch (err) {
					response.writeHead(400);
					response.end('Invalid JSON');
					return;
				}

				handleApiCall(action, requestData);
			});
		} else {
			handleApiCall(action, null);
		}
		return;
	}

	function handleApiCall(action, requestData) {
		if (!apiActions[action]) action = 'unknown';

		apiActions[action](requestData, function (data, statusCode) {
			var json = JSON.stringify(data);
			var duration = process.hrtime(startTime);

			response.writeHead(statusCode || 200, {
				'Content-Type': 'application/json',
				'X-Duration': Math.round((duration[0] * 1000 + duration[1] / 1000000) * 10) / 10,
			});
			response.end(json);
		});
	}

	if (url.pathname === '/preview' || url.pathname === '/full-preview') {
		if (!previewImage) {
			response.writeHead(404);
			response.end('No preview image available');
			return;
		}

		response.writeHead(200, {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'must-revalidate',
			Expires: '0',
		});

		if (url.pathname === '/preview') {
			response.end(previewImage);
		} else if (url.pathname === '/full-preview') {
			fs.createReadStream(previewImageName).pipe(response);
		}
		return;
	}

	if (url.pathname === '/capture') {
		response.writeHead(301, { Location: '/capture/' });
		response.end();
		return;
	}

	// serve static files:
	for (var i = 0; i < mounts.length; i++) {
		if (mounts[i](request, response)) break;
	}
});

httpShutdownExtend(server);
server.listen(8080);

function shutdown() {
	clearInterval(updatePreviewImageInterval);
	clearInterval(updateStatusInterval);
	server.shutdown();
}

//catches ctrl+c event
process.on('SIGINT', shutdown);

process.on('SIGTERM', shutdown);
