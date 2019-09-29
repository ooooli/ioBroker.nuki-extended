'use strict';
const adapterName = require('./io-package.json').common.name;
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

const _request = require('request-promise');
const _http = require('express')();
const _parser = require('body-parser');
const _ip = require('ip');
const _uuid = require('uuid/v5');

const Bridge = require('./lib/nuki-bridge-api');
const Nuki = require('nuki-web-api');


/*
 * internal libraries
 */
const Library = require(__dirname + '/lib/library.js');
const _LOCK = require(__dirname + '/_LOCK.js');
const _OPENER = require(__dirname + '/_OPENER.js');
const _NODES = require(__dirname + '/_NODES.js');


/*
 * constants & variables initiation
 */
const MAX_RETRY_ACTIONS = 3;

let adapter;
let library;
let unloaded;
let refreshCycleWebApi, refreshCycleBridgeApi;

let setup = [];
let nukiWebApi = null, BRIDGES = {}, DEVICES = {}, CALLBACKS = {};
let listener = false;


/*
 * ADAPTER
 *
 */
function startAdapter(options)
{
	options = options || {};
	adapter = new utils.Adapter({ ...options, name: adapterName });
	
	/*
	 * ADAPTER READY
	 *
	 */
	adapter.on('ready', function()
	{
		library = new Library(adapter, { nodes: _NODES, updatesInLog: true });
		unloaded = false;
		
		// Check Node.js Version
		let version = parseInt(process.version.substr(1, process.version.indexOf('.')-1));
		if (version <= 6)
			return library.terminate('This Adapter is not compatible with your Node.js Version ' + process.version + ' (must be >= Node.js v7).', true);
		
		// Check port
		if (!adapter.config.callbackPort)
			adapter.config.callbackPort = 51989;
		
		if (adapter.config.callbackPort < 10000 || adapter.config.callbackPort > 65535)
		{
			adapter.log.warn('The callback port (' + adapter.config.callbackPort + ') is incorrect. Provide a port between 10.000 and 65.535! Using port 51989 now.');
			adapter.config.callbackPort = 51989;
		}
		
		// retrieve all values from states to avoid message "Unsubscribe from all states, except system's, because over 3 seconds the number of events is over 200 (in last second 0)"
		adapter.getStates(adapterName + '.' + adapter.instance + '.*', (err, states) =>
		{
			if (err || !states) return;
			
			for (let state in states)
				library.setDeviceState(state.replace(adapterName + '.' + adapter.instance + '.', ''), states[state] && states[state].val);
		
			// start
			initNukiAPIs();
		});
	});
	
	/*
	 * ADAPTER UNLOAD
	 *
	 */
	adapter.on('unload', function(callback)
	{
		try
		{
			adapter.log.info('Adapter stopped und unloaded.');
			
			unloaded = true;
			if (refreshCycleWebApi) clearTimeout(refreshCycleWebApi);
			if (refreshCycleBridgeApi) clearTimeout(refreshCycleBridgeApi);
			
			callback();
		}
		catch(err)
		{
			callback();
		}
	});

	/*
	 * STATE CHANGE
	 *
	 */
	adapter.on('stateChange', function(node, object)
	{
		adapter.log.debug('State of ' + node + ' has changed ' + JSON.stringify(object) + '.');
		
		let state = node.substr(node.lastIndexOf('.')+1);
		let action = object !== undefined && object !== null ? object.val : 0;
		let path = node.substr(0, node.lastIndexOf('.')).replace(adapterName + '.' + adapter.instance + '.', '');
		let root = path.split('.').slice(0, 2).join('.');
		
		// apply an action on the callback
		if (state === '_delete' && object && object.ack !== true)
		{
			let bridgeId = library.getDeviceState(root + '.bridgeId');
			let url = library.getDeviceState(path + '.url');
			
			// ID or url could not be retrived
			if (!bridgeId || !url || url == '{}')
			{
				adapter.log.warn('Error deleting callback: No Bridge ID or URL given!');
				return;
			}
			
			// delete callback
			let callbackIndex = CALLBACKS[bridgeId].findIndex(cb => cb.url === url);
			if (callbackIndex > -1)
			{
				CALLBACKS[bridgeId][callbackIndex].remove().then(() =>
				{
					adapter.log.info('Deleted callback with URL ' + url + '.');
					
					// delete objects
					let path = BRIDGES[bridgeId].data.path + '.callbacks.' + _uuid(url, _uuid.URL);
					library.del(path, true);
					
					// update callback list
					CALLBACKS[bridgeId].splice(callbackIndex, 1);
					library._setValue(BRIDGES[bridgeId].data.path + '.callbacks.list', JSON.stringify(CALLBACKS[bridgeId].map(cb => {return {'callbackId': cb.callbackId, 'url': cb.url}})));
				})
				.catch(err => adapter.log.debug('Error removing callback (' + JSON.stringify(err) + ')!'));
			}
			else
				adapter.log.warn('Error deleting callback with URL ' + url + ': ' + (err ? err.message : 'No Callback ID given!'));
		}
		
		// apply an action on the door
		if (state === '_ACTION' && Number.isInteger(action) && action > 0 && object.ack !== true)
		{
			library._setValue(node, 0, true);
			let nukiId = library.getDeviceState(path + '.id');
			
			// ID or type could not be retrived
			if (!nukiId)
			{
				adapter.log.warn('Error triggering action on the Nuki device: No Nuki ID given!');
				return false;
			}
			
			// Smartlock
			let device = DEVICES[nukiId];
			action = { id: action };
			
			switch (device.type.toLowerCase())
			{
				case 'smartlock':
					action.name = _LOCK.ACTIONS[action.id];
					break;
					
				case 'opener':
					action.name = _OPENER.ACTIONS[action.id];
					break;
					
				case 'box':
				default:
					adapter.log.warn('Error triggering action on the Nuki device: Wrong Nuki type given!');
					return false;
					break;
			}
			
			// apply action
			setAction(device, action);
		}
	});

	/*
	 * HANDLE MESSAGES
	 *
	 */
	adapter.on('message', function(msg)
	{
		adapter.log.debug('Message: ' + JSON.stringify(msg));
		
		switch(msg.command)
		{
			case 'discover':
				adapter.log.info('Discovering bridges..');
				
				_request({ url: 'https://api.nuki.io/discover/bridges', json: true })
					.then(res =>
					{
						let discovered = res.bridges;
						adapter.log.info('Bridges discovered: ' + discovered.length);
						adapter.log.debug(JSON.stringify(discovered));
						
						library.msg(msg.from, msg.command, {result: true, bridges: discovered}, msg.callback);
					})
					.catch(err =>
					{
						adapter.log.warn('Error while discovering bridges: ' + err.message);
						library.msg(msg.from, msg.command, {result: false, error: err.message}, msg.callback);
					});
				break;
			
			case 'auth':
				adapter.log.info('Authenticate bridge..');
				
				_request({ url: 'http://' + msg.message.bridgeIp + ':' + msg.message.bridgePort + '/auth', json: true })
					.then(res =>
					{
						library.msg(msg.from, msg.command, {result: true, token: res.token}, msg.callback);
					})
					.catch(err =>
					{
						adapter.log.warn('Error while authenticating bridge: ' + err.message);
						library.msg(msg.from, msg.command, {result: false, error: err.message}, msg.callback);
					});
				break;
		}
	});
	
	return adapter;	
};


/**
 * Main function
 *
 */
function initNukiAPIs()
{
	library.set(library.getNode('bridgeApiSync'), false);
	library.set(library.getNode('webApiSync'), false);
	
	/*
	 * WEB API
	 *
	 */
	if (!adapter.config.api_token)
		adapter.log.info('No Nuki Web API token provided.');
	
	else
	{
		nukiWebApi = new Nuki(adapter.config.api_token);
		setup.push('web_api');
		
		// get locks
		getWebApi();
	}
	
	
	/*
	 * BRIDGE API
	 *
	 */
	// check if bridges have been defined
	if (adapter.config.bridges === undefined || adapter.config.bridges.length == 0)
		return library.terminate('No bridges have been defined in settings so far!');
	
	else
	{
		setup.push('bridge_api');
		library.set(Library.CONNECTION, true);
		
		// go through bridges
		let listener = adapter.config.bridges.map((device, i) =>
		{
			let bridge_ident = device.bridge_name ? 'with name ' + device.bridge_name : (device.bridge_id ? 'with ID ' + device.bridge_id : 'with index ' + i);
			
			// check if Bridge is enabled in settings
			if (!device.active)
			{
				adapter.log.info('Bridge ' + bridge_ident + ' is disabled in adapter settings. Thus, ignored.');
				return Promise.resolve(false);
			}
			
			// check if API settings are set
			if (!device.bridge_ip || !device.bridge_token)
			{
				adapter.log.warn('IP or API token missing for bridge ' + bridge_ident + '! Please go to settings and fill in IP and the API token first!');
				return Promise.resolve(false);
			}
			
			// initialize Nuki Bridge class
			library.set(library.getNode('bridges'));
			device.path = 'bridges.' + (device.bridge_name ? library.clean(device.bridge_name, true, '_') : device.bridge_id);
			
			let bridge = {
				'data': device,
				'instance': new Bridge.Bridge(device.bridge_ip, device.bridge_port || 8080, device.bridge_token)
			};
			
			// index bridge
			BRIDGES[device.bridge_id] = bridge;
			
			// get bridge info
			getBridgeApi(bridge);
			
			// get current callback URLs
			return bridge.instance.getCallbacks().then(cbs =>
			{
				adapter.log.debug('Retrieved current callbacks from Nuki Bridge ' + bridge_ident + '.');
				CALLBACKS[device.bridge_id] = cbs;
				setCallbackNodes(device.bridge_id);
				
				// check for enabled callback
				if (adapter.config.refreshBridgeApiType == 'callback')
				{
					let url = 'http://' + _ip.address() + ':' + adapter.config.callbackPort + '/nuki-api-bridge'; // NOTE: https is not supported according to API documentation
					
					// attach callback
					if (CALLBACKS[device.bridge_id].findIndex(cb => cb.url === url) === -1)
					{
						adapter.log.debug('Adding callback with URL ' + url + ' to Nuki Bridge ' + bridge_ident + '.');
						
						// set callback on bridge
						bridge.instance.addCallback(_ip.address(), adapter.config.callbackPort, false)
							.then(res =>
							{
								adapter.log.info('Callback (with URL ' + res.url + ') attached to Nuki Bridge ' + bridge_ident + '.');
								CALLBACKS[device.bridge_id].push(res);
								setCallbackNodes(device.bridge_id);
							})
							.catch(err =>
							{
								if (err && err.error && err.error.message === 'callback already added')
									adapter.log.debug('Callback (with URL ' + url + ') already attached to Nuki Bridge ' + bridge_ident + '.');
								
								else
								{
									adapter.log.warn('Callback not attached due to error. See debug log for details.');
									adapter.log.debug(JSON.stringify(err));
								}
							});
					}
					else
						adapter.log.debug('Callback (with URL ' + url + ') already attached to Nuki Bridge ' + bridge_ident + '.');
					
					return Promise.resolve(true);
				}
				
				return Promise.resolve(false);
			})
			.catch(err => adapter.log.debug('Error retrieving callbacks (' + JSON.stringify(err) + ')!'));
		});
		
		// attach server to listen (only one listener for all Nuki Bridges)
		// @see https://stackoverflow.com/questions/9304888/how-to-get-data-passed-from-a-form-in-express-node-js/38763341#38763341
		Promise.all(listener).then(values =>
		{
			if (values.findIndex(el => el === true) > -1)
			{
				_http.use(_parser.json());
				_http.use(_parser.urlencoded({extended: false}));
				
				_http.post('/nuki-api-bridge', (req, res) =>
				{
					if (req && req.body)
					{
						let payload = {'nukiId': req.body.nukiId, 'state': { ...req.body, 'timestamp': new Date().toISOString().substr(0,19) + '+00:00' }};
						if (payload.state.nukiId) delete payload.state.nukiId;
						
						adapter.log.debug('Received payload via callback: ' + JSON.stringify(payload));
						updateLock(payload);
						res.sendStatus(200);
						
						// update Web API as well
						getWebApi();
					}
					else
					{
						res.sendStatus(500);
						adapter.log.warn('main(): ' + e.message);
					}
				});
				
				_http.listen(adapter.config.callbackPort, () => adapter.log.info('Listening for Nuki events on port ' + adapter.config.callbackPort + '.'));
			}
			else
				adapter.log.info('Not listening for Nuki events.');
		})
		.catch(err => adapter.log.debug('Error resolving listeners (' + JSON.stringify(err) + ')!'));
	}
	
	// periodically refresh settings
	// Web API
	if (!adapter.config.refreshWebApi)
		adapter.config.refreshWebApi = 0;
	
	else if (adapter.config.refreshWebApi > 0 && adapter.config.refreshWebApi < 5)
	{
		adapter.log.warn('Due to performance reasons, the refresh rate can not be set to less than 5 seconds. Using 5 seconds now for Nuki Web API.');
		adapter.config.refreshWebApi = 5;
	}
	
	if (adapter.config.refreshWebApi > 0 && !unloaded)
	{
		adapter.log.info('Polling Nuki Web API with a frequency of ' + adapter.config.refreshWebApi + 's.');
		refreshCycleWebApi = setTimeout(function updaterWebApi()
		{
			// update Nuki Web API
			getWebApi();
			
			// set interval
			if (!unloaded)
				refreshCycleWebApi = setTimeout(updaterWebApi, Math.round(parseInt(adapter.config.refreshWebApi)*1000));
			
		}, Math.round(parseInt(adapter.config.refreshWebApi)*1000));
	}
	else
		adapter.log.info('Polling Nuki Web API deactivated.');
	
	// Bridge API
	if (!adapter.config.refreshBridgeApi)
		adapter.config.refreshBridgeApi = 0;
	
	else if (adapter.config.refreshBridgeApi > 0 && adapter.config.refreshBridgeApi < 5)
	{
		adapter.log.warn('Due to performance reasons, the refresh rate can not be set to less than 5 seconds. Using 5 seconds now for Nuki Bridge API.');
		adapter.config.refreshBridgeApi = 5;
	}
	
	if (adapter.config.refreshBridgeApi > 0 && !unloaded && adapter.config.refreshBridgeApiType == 'polling')
	{
		adapter.log.info('Polling Nuki Bridge API with a frequency of ' + adapter.config.refreshBridgeApi + 's.');
		refreshCycleBridgeApi = setTimeout(function updaterBridgeApi()
		{
			// update Nuki Bridge API
			for (let key in BRIDGES) {getBridgeApi(BRIDGES[key])}
			
			// set interval
			if (!unloaded)
				refreshCycleBridgeApi = setTimeout(updaterBridgeApi, Math.round(parseInt(adapter.config.refreshBridgeApi)*1000));
			
		}, Math.round(parseInt(adapter.config.refreshBridgeApi)*1000));
	}
	else if (adapter.config.refreshBridgeApi == 0 && !unloaded && (!adapter.config.refreshBridgeApiType || adapter.config.refreshBridgeApiType == 'polling'))
		adapter.log.info('Polling Nuki Bridge API deactivated.');
}


/**
 * Retrieve from Bridge API.
 *
 */
function getBridgeApi(bridge)
{
	library.set(library.getNode('bridgeApiSync'), true, true);
	library.set(library.getNode('bridgeApiLast'), new Date().toISOString().substr(0,19) + '+00:00');
	
	// get current callback URLs
	bridge.instance.getCallbacks().then(cbs =>
	{
		CALLBACKS[bridge.data.bridge_id] = cbs;
		setCallbackNodes(bridge.data.bridge_id);
	})
	.catch(err => adapter.log.debug('Error retrieving callbacks (' + JSON.stringify(err) + ')!'));
	
	// get nuki's
	adapter.log.silly('Retrieving from Nuki Bridge API (Bridge ' + bridge.data.bridge_ip + ')..');
	bridge.instance.list().then(nukis =>
	{
		nukis.forEach(payload =>
		{
			// remap states
			payload.bridge = bridge.data.bridge_id !== '' ? bridge.data.bridge_id : undefined;
			payload['state'] = payload['lastKnownState'];
			delete payload['lastKnownState'];
			
			adapter.log.debug('getBridgeApi(): ' + JSON.stringify(payload));
			updateLock(payload);
		});
	})
	.catch(err =>
	{
		adapter.log.warn('Failed retrieving /list from Nuki Bridge' + (bridge.data.bridge_name ? ' with name ' + bridge.data.bridge_name : (bridge.data.bridge_id ? ' with ID ' + bridge.data.bridge_id : (bridge.data.bridge_ip ? ' with ip ' + bridge.data.bridge_ip : ''))) + '!');
		adapter.log.debug('getBridgeApi(): ' + err.message);
		
		if (err.message.indexOf('503') > -1)
		{
			adapter.log.info('Trying again in 10s..');
			setTimeout(updaterBridgeApi, 10*1000);
		}
	});
	
	// get bridge info
	bridge.instance.info().then(payload =>
	{
		// enrich payload
		payload.name = bridge.data.bridge_name;
		payload.ip = bridge.data.bridge_ip;
		payload.port = bridge.data.bridge_port || 8080;
		
		// get bridge ID if not given
		if (bridge.data.bridge_id === undefined || bridge.data.bridge_id === '')
		{
			adapter.log.debug('Adding missing Bridge ID for bridge with IP ' + bridge.data.bridge_ip + '.');
			bridge.data.bridge_id = payload.ids.serverId;
			
			// update bridge ID in configuration
			adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) =>
			{
				obj.native.bridges.forEach((entry, i) =>
				{
					if (entry.bridge_ip === bridge.data.bridge_ip)
					{
						obj.native.bridges[i].bridge_id = bridge.data.bridge_id;
						adapter.setForeignObject(obj._id, obj);
					}
				});
			});
		}
		
		// set payload for bridge
		library.set({node: bridge.data.path, description: 'Bridge ' + (bridge.data.bridge_name ? bridge.data.bridge_name + ' ' : '') + '(' + bridge.data.bridge_ip + ')', role: 'channel'});
		readData('', payload, bridge.data.path);
	})
	.catch(err =>
	{
		adapter.log.warn('Failed retrieving /info from Nuki Bridge' + (bridge.data.bridge_name ? ' with name ' + bridge.data.bridge_name : (bridge.data.bridge_id ? ' with ID ' + bridge.data.bridge_id : (bridge.data.bridge_ip ? ' with ip ' + bridge.data.bridge_ip : ''))) + '!');
		adapter.log.debug('getBridgeApi(): ' + err.message);
	});
}


/**
 * Retrieve from Web API.
 *
 */
function getWebApi()
{
	if (!nukiWebApi) return;
	library.set(library.getNode('webApiSync'), true, true);
	library.set(library.getNode('webApiLast'), new Date().toISOString().substr(0,19) + '+00:00');
	
	adapter.log.silly('getWebApi(): Retrieving from Nuki Web API..');
	
	// get nukis
	nukiWebApi.getSmartlocks().then(smartlocks =>
	{
		smartlocks.forEach(smartlock =>
		{
			adapter.log.debug('getWebApi(): ' + JSON.stringify(smartlock));
			
			// remap states
			smartlock.nukiId = smartlock.smartlockId;
			smartlock.deviceType = smartlock.type;
			if (smartlock.state) smartlock.state.timestamp = new Date().toISOString().substr(0,19) + '+00:00';
			delete smartlock.smartlockId;
			delete smartlock.type;
			
			// get config
			if (adapter.config.syncConfig !== true)
			{
				if (smartlock.config) delete smartlock.config;
				if (smartlock.advancedConfig) delete smartlock.advancedConfig;
				if (smartlock.openerAdvancedConfig) delete smartlock.openerAdvancedConfig;
				if (smartlock.webConfig) delete smartlock.webConfig;
			}
			
			// update lock
			updateLock(smartlock);
	
			// get logs
			nukiWebApi.getSmartlockLogs(smartlock.nukiId, { limit: 1000 }).then(log =>
			{
				library.set({node: DEVICES[smartlock.nukiId].path + '.logs', description: 'Logs / History of Nuki'}, JSON.stringify(log.slice(0, 250)));
				
			}).catch(err => {adapter.log.warn('getWebApi(): Error retrieving logs: ' + err.message)});
			
			// get users
			if (adapter.config.syncUsers)
			{
				nukiWebApi.getSmartlockAuth(smartlock.nukiId).then(users =>
				{
					library.set({ ...library.getNode('users'), 'node': DEVICES[smartlock.nukiId].path + '.users' });
					users.forEach(user =>
					{
						user.name = user.name || 'unknown';
						
						let nodePath = DEVICES[smartlock.nukiId].path + '.users.' + library.clean(user.name, true, '_');
						library.set({node: nodePath, description: 'User ' + user.name, role: 'channel'});
						readData('', user, nodePath);
					});
					
				}).catch(err => {adapter.log.warn('getWebApi(): Error retrieving users: ' + err.message)});
			}
		});
		
	}).catch(err => {adapter.log.warn('getWebApi(): Error retrieving smartlocks: ' + err.message)});
	
	// get notifications
	nukiWebApi.getNotification().then(notifications =>
	{
		readData('notifications', notifications, 'info');
		
	}).catch(err => {adapter.log.warn('getWebApi(): Error retrieving notifications: ' + err.message)});
}


/**
 * Update states of Nuki Door based on payload.
 *
 */
function updateLock(payload)
{
	// index Nuki
	let type, path;
	if (DEVICES[payload.nukiId] === undefined || !DEVICES[payload.nukiId].path)
	{
		let actions = null;
		
		// 
		if (!payload.name || payload.deviceType === undefined)
		{
			adapter.log.debug('Error updating device due to missing data (' + JSON.stringify(payload) + ').');
			return false;
		}
		
		// Nuki Smartlock
		if (payload.deviceType === 0 || !payload.deviceType)
		{
			library.set(library.getNode('smartlocks'));
			type = 'Smartlock';
			actions = _LOCK.ACTIONS;
		}
		
		// Nuki Box
		else if (payload.deviceType === 1)
		{
			library.set(library.getNode('boxes'));
			type = 'Box';
		}
		
		// Nuki Opener
		else if (payload.deviceType === 2)
		{
			library.set(library.getNode('openers'));
			type = 'Opener';
			actions = _OPENER.ACTIONS;
		}
		
		// index device
		path = type.toLowerCase() + 's.' + library.clean(payload.name, true, '_');
		DEVICES[payload.nukiId] = { id: payload.nukiId, name: payload.name, type: type, path: path, state: (payload.state && payload.state.state) || 0, bridge: null };
		
		// add action
		if (actions !== null)
		{
			library.set({ ...library.getNode('action'), 'node': path + '._ACTION', 'common': { 'write': true, 'states': actions }}, 0);
			adapter.subscribeStates(path + '._ACTION'); // attach state listener
		}
	}
	
	// retrieve Nuki name
	else
		path = DEVICES[payload.nukiId].path;
	
	
	// update bridge
	if (payload.bridge !== undefined)
		DEVICES[payload.nukiId].bridge = payload.bridge;
	
	// update instance
	if (payload.nuki !== undefined)
		DEVICES[payload.nukiId].instance = payload.nuki;
	
	// add additional states
	if (DEVICES[payload.nukiId].type == 'Smartlock' && payload.state.doorState)
		payload.state.closed = payload.state.doorState;
	
	if (DEVICES[payload.nukiId].type == 'Smartlock' && payload.state.state)
		payload.state.locked = payload.state.state;
	
	// remove unnecessary states
	if (payload.state && payload.state.stateName) delete payload.state.stateName;
	if (payload.nuki) delete payload.nuki;
	
	// create / update device
	adapter.log.debug('Updating lock ' + path + ' with payload: ' + JSON.stringify(payload));
	library.set({node: path, description: '' + DEVICES[payload.nukiId].name, role: 'channel'});
	readData('', payload, path);
}


/**
 * Apply an action on either via Nuki Bridge API or via Nuki Web API.
 *
 */
function setAction(device, action, api = 'bridge', retry = 0)
{
	adapter.log.info('Triggered action -' + action.name + '- on Nuki ' + device.type + ' ' + device.name + '.');
	
	// try Bridge API
	if (device.instance !== undefined && device.instance !== null && api == 'bridge')
	{
		adapter.log.debug('Action applied on Bridge API.');
		
		device.instance.lockAction(action.id)
			.then(() =>
			{
				adapter.log.info('Successfully triggered action -' + action.name + '- on Nuki ' + device.type + ' ' + device.name + ' (via Bridge API).');
				return Promise.resolve(true);
			})
			.catch(err =>
			{
				adapter.log.warn('Error triggering action -' + action.name + '- on Nuki ' + device.type + ' ' + device.name + '. See debug log for details.');
				adapter.log.debug(err.message);
				
				// retry
				retry++;
				if (retry <= MAX_RETRY_ACTIONS)
					return Promise.resolve(false);
				
				if (nukiWebApi)
				{
					adapter.log.info('Try again (' + retry + 'x) with Nuki Web API..');
					return setAction(device, 'web', retry);
				}
				else
				{
					adapter.log.info('Try again (' + retry + 'x) in 10s with Nuki Bridge API..');
					setTimeout(() =>
					{
						return setAction(device, 'bridge', retry);
						
					}, 10*1000);
				}
			});
	}
	
	// try Web API
	else if (nukiWebApi !== null && api == 'web')
	{
		adapter.log.debug('Action applied on Web API.');
		
		nukiWebApi.setAction(device.id, action.id)
			.then(() =>
			{
				adapter.log.info('Successfully triggered action -' + action.name + '- on Nuki ' + device.type + ' ' + device.name + ' (via Web API).');
				return Promise.resolve(true);
			})
			.catch(err =>
			{
				adapter.log.warn('Error triggering action -' + action.name + '- on Nuki ' + device.type + ' ' + device.name + '. See debug log for details.');
				adapter.log.debug(err.message);
				
				// retry
				retry++;
				if (retry <= MAX_RETRY_ACTIONS)
					return Promise.resolve(false);
				
				adapter.log.info('Try again (' + retry + 'x) in 10s with Nuki Bridge API..');
				setTimeout(() =>
				{
					return setAction(device, 'bridge', retry);
					
				}, 10*1000);
			});
	}
	
	// No API given
	else
		return Promise.resolve(false);
}


/**
 * Refresh Callbacks of the Nuki Bridge.
 *
 */
function setCallbackNodes(bridgeId)
{
	let path = BRIDGES[bridgeId].data.path + '.callbacks';
	library.del(path, true, () =>
	{
		// create states for callbacks
		let cbs = [];
		CALLBACKS[bridgeId].forEach(cb =>
		{
			let node = path + '.' + _uuid(cb.url, _uuid.URL);
			cbs.push({'callbackId': cb.callbackId, 'url': cb.url});
			
			library.set({ ...library.getNode('callbacks.callback'), 'node': node });
			library.set({ ...library.getNode('callbacks.callback.url'), 'node': node + '.url' }, cb.url);
			library.set({ ...library.getNode('callbacks.callback.delete'), 'node': node + '._delete'});
			adapter.subscribeStates(node + '._delete'); // attach state listener
		});
		
		// create channel and callback list
		library.set({ ...library.getNode('callbacks'), 'node': path });
		library.set({ ...library.getNode('callbacks.list'), 'node': path + '.list'}, JSON.stringify(cbs));
	});
}


/**
 * Read given data and set states.
 *
 */
function readData(key, data, prefix)
{
	// only proceed if data is given
	if (data === undefined || data === 'undefined')
		return false;
	
	// get node details
	key = key ? library.clean(key, false, '_') : '';
	let node = library.getNode(prefix && prefix.indexOf('users.') > -1 ? 'users.' + key : key);
	
	// add node details
	if (key.indexOf('.state') > -1) node = Object.assign({}, node, {'common': {'states': prefix.indexOf('opener') === -1 ? _LOCK.STATES : _OPENER.STATES }});
	if (key.indexOf('.lastAction') > -1) node = Object.assign({}, node, {'common': {'states': prefix.indexOf('opener') === -1 ? _LOCK.ACTIONS : _OPENER.ACTIONS }});
	
	// loop nested data
	if (data !== null && typeof data == 'object' && (!node.convert && node.convert != 'array'))
	{
		if (Object.keys(data).length > 0)
		{
			// create channel
			if (node.role == 'channel')
			{
				library.set({
					node: prefix + '.' + (node.state || key),
					role: 'channel',
					description: node.description || library.ucFirst(key.substr(key.lastIndexOf('.')+1))
				});
			}
			
			// read nested data
			for (let nestedKey in data)
			{
				readData((key ? key + '.' : '') + nestedKey, data[nestedKey], prefix);
			}
		}
	}
	
	// write to states
	else
	{
		// convert data
		data = convertNode(node, data, prefix);
		
		// skip
		if (node.skip) return;
		
		// create channel if node.state is nested
		if (node.state && node.state.indexOf('.') > -1 && (prefix + '.' + node.state.substr(0, node.state.lastIndexOf('.'))) != (prefix + '.' + key.substr(0, key.lastIndexOf('.'))))
			readData(node.state.substr(0, node.state.indexOf('.')), { [node.state.substr(node.state.indexOf('.')+1)]: data }, prefix);
		
		// set state
		let state = JSON.parse(JSON.stringify(node)); // copy node
		state.node = prefix + '.' + (node.state || key);
		state.description = node.description || library.ucFirst(key.substr(key.lastIndexOf('.')+1))
		library.set(state, data);
	}
}


/**
 * Convert.
 *
 */
function convertNode(node, data, prefix)
{
	// flatten Array
	if (Array.isArray(data))
		data = data.join(',');
	
	// type is boolean, but states are given
	if (node.type == 'boolean' && node.common && node.common.states)
		data = node.common.states[data] == 'true';
	
	// type is boolean, but number given
	if (node.type == 'boolean' && Number.isInteger(data) && !(node.common && node.common.states))
		data = data === 1;
	
	return data;
}


/*
 * COMPACT MODE
 * If started as allInOne/compact mode => return function to create instance
 *
 */
if (module && module.parent)
	module.exports = startAdapter;
else
	startAdapter(); // or start the instance directly