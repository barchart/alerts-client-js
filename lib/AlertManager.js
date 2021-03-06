const array = require('@barchart/common-js/lang/array'),
	assert = require('@barchart/common-js/lang/assert'),
	is = require('@barchart/common-js/lang/is'),
	Disposable = require('@barchart/common-js/lang/Disposable'),
	Event = require('@barchart/common-js/messaging/Event'),
	object = require('@barchart/common-js/lang/object'),
	promise = require('@barchart/common-js/lang/promise');

const EndpointBuilder = require('@barchart/common-js/api/http/builders/EndpointBuilder'),
	ErrorInterceptor = require('@barchart/common-js/api/http/interceptors/ErrorInterceptor'),
	Gateway = require('@barchart/common-js/api/http/Gateway'),
	ProtocolType = require('@barchart/common-js/api/http/definitions/ProtocolType'),
	ResponseInterceptor = require('@barchart/common-js/api/http/interceptors/ResponseInterceptor'),
	VerbType = require('@barchart/common-js/api/http/definitions/VerbType');

const convertBaseCodeToUnitCode = require('@barchart/marketdata-api-js/lib/utilities/convert/baseCodeToUnitCode'),
	formatPrice = require('@barchart/marketdata-api-js/lib/utilities/format/price'),
	valueParser = require('@barchart/marketdata-api-js/lib/utilities/parse/ddf/value');

const validate = require('./data/validators/validate');

const AdapterBase = require('./adapters/AdapterBase'),
	JwtProvider = require('./security/JwtProvider');

const Configuration = require('./common/Configuration');

const version = require('./meta').version;

module.exports = (() => {
	'use strict';

	const regex = { };

	regex.hosts = { };
	regex.hosts.production = /(prod)/i;
	
	const DEFAULT_SECURE_PORT = 443; 

	/**
	 * The **central component of the SDK**. It is responsible for connecting to Barchart's
	 * Alerting Service, querying existing alerts, creating new alerts, and monitoring the status
	 * of existing alerts.
	 *
	 * @public
	 * @exported
	 * @extends {Disposable}
	 * @param {String} host - Barchart Alerting Service's hostname.
	 * @param {Number} port - Barchart Alerting Service's TCP port number.
	 * @param {Boolean} secure - If true, the transport layer will use encryption (e.g. HTTPS, WSS, etc).
	 * @param {Function} adapterClazz - The transport strategy. Specifically, the constructor function for a class extending {@link AdapterBase}.
	 */
	class AlertManager extends Disposable {
		constructor(host, port, secure, adapterClazz) {
			super();

			assert.argumentIsRequired(host, 'host', String);
			assert.argumentIsRequired(port, 'port', Number);
			assert.argumentIsRequired(secure, 'secure', Boolean);
			assert.argumentIsRequired(adapterClazz, 'adapterClazz', Function);

			if (!is.extension(AdapterBase, adapterClazz)) {
				throw new Error('The "adapterClazz" argument must be the constructor for a class which extends AdapterBase.');
			}

			this._host = host;
			this._port = port;
			this._secure = secure;

			this._adapter = null;
			this._adapterClazz = adapterClazz;

			this._connectPromise = null;

			this._alertSubscriptionMap = { };
			this._triggerSubscriptionMap = { };
		}

		/**
		 * Attempts to establish a connection to the backend. This function should be invoked
		 * immediately following instantiation. Once the resulting promise resolves, a
		 * connection has been established and other instance methods can be used.
		 *
		 * @public
		 * @param {JwtProvider} jwtProvider - Your implementation of {@link JwtProvider}.
		 * @returns {Promise<AlertManager>}
		 */
		connect(jwtProvider) {
			return Promise.resolve()
				.then(() => {
					assert.argumentIsRequired(jwtProvider, 'jwtProvider', JwtProvider, 'JwtProvider');

					checkDispose(this, 'connect');
				}).then(() => {
					if (this._connectPromise === null) {
						const alertAdapterPromise = Promise.resolve()
							.then(() => {
								const AdapterClazz = this._adapterClazz;
								const adapter = new AdapterClazz(this._host, this._port, this._secure, onAlertCreated.bind(this), onAlertMutated.bind(this), onAlertDeleted.bind(this), onAlertTriggered.bind(this), onTriggersCreated.bind(this), onTriggersMutated.bind(this), onTriggersDeleted.bind(this));

								return promise.timeout(adapter.connect(jwtProvider), 10000, 'Alert service is temporarily unavailable. Please try again later.');
							});

						this._connectPromise = Promise.all([alertAdapterPromise])
							.then((results) => {
								this._adapter = results[0];

								return this;
							}).catch((e) => {
								this._connectPromise = null;

								throw e;
							});
					}

					return this._connectPromise;
				});
		}

		/**
		 * Gets a single alert by its identifier.
		 *
		 * @public
		 * @param {Schema.Alert|Schema.AlertIdentifier} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		retrieveAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'retrieve alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					return this._adapter.retrieveAlert(alert);
				});
		}

		/**
		 * Gets a set of alerts, matching query criteria.
		 *
		 * @public
		 * @param {Schema.AlertQuery} query
		 * @returns {Promise<Schema.Alert[]>}
		 */
		retrieveAlerts(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'retrieve alerts');

					validate.alert.forUser(query);
				}).then(() => {
					return this._adapter.retrieveAlerts(query);
				}).then((results) => {
					if (query.filter && query.filter.alert_type) {
						return results.filter((result) => result.alert_type === query.filter.alert_type);
					} else {
						return results;
					}
				}).then((results) => {
					if (query.filter && query.filter.symbol) {
						return results.filter((result) => result.conditions.some((c) => (c.property.target.type === 'symbol' && c.property.target.identifier ===  query.filter.symbol) || (c.property.type === 'symbol' && c.operator.operand === query.filter.symbol)));
					} else {
						return results;
					}
				}).then((results) => {
					if (query.filter && query.filter.target && query.filter.target.identifier) {
						return results.filter((result) => result.conditions.some((c) => c.property.target.identifier === query.filter.target.identifier));
					} else {
						return results;
					}
				}).then((results) => {
					if (query.filter && query.filter.condition && (typeof(query.filter.condition.operand) === 'string' || typeof(query.filter.condition.operand) === 'number')) {
						return results.filter((result) => result.conditions.some((c) => c.operator.operand === query.filter.condition.operand.toString()));
					} else {
						return results;
					}
				});
		}

		/**
		 * Registers four separate callbacks which will be invoked when alerts are created,
		 * deleted, changed, or triggered.
		 *
		 * @public
		 * @param {Object} query
		 * @param {String} query.user_id
		 * @param {String} query.alert_system
		 * @param {Callbacks.AlertMutatedCallback} changeCallback
		 * @param {Callbacks.AlertDeletedCallback} deleteCallback
		 * @param {Callbacks.AlertCreatedCallback} createCallback
		 * @param {Callbacks.AlertTriggeredCallback}  triggerCallback
		 * @returns {Disposable}
		 */
		subscribeAlerts(query, changeCallback, deleteCallback, createCallback, triggerCallback) {
			checkStatus(this, 'subscribe alerts');

			validate.alert.forUser(query);

			assert.argumentIsRequired(changeCallback, 'changeCallback', Function);
			assert.argumentIsRequired(deleteCallback, 'deleteCallback', Function);
			assert.argumentIsRequired(createCallback, 'createCallback', Function);
			assert.argumentIsRequired(triggerCallback, 'triggerCallback', Function);

			const userId = query.user_id;
			const alertSystem = query.alert_system;

			if (!this._alertSubscriptionMap.hasOwnProperty(userId)) {
				this._alertSubscriptionMap[userId] = {};
			}

			if (!this._alertSubscriptionMap[userId].hasOwnProperty(alertSystem)) {
				this._alertSubscriptionMap[userId][alertSystem] = {
					createEvent: new Event(this),
					changeEvent: new Event(this),
					deleteEvent: new Event(this),
					triggerEvent: new Event(this),
					subscribers: 0
				};
			}

			const subscriptionData = this._alertSubscriptionMap[userId][alertSystem];

			if (subscriptionData.subscribers === 0) {
				subscriptionData.implementationBinding = this._adapter.subscribeAlerts(query);
			}

			subscriptionData.subscribers = subscriptionData.subscribers + 1;

			const createRegistration = subscriptionData.createEvent.register(createCallback);
			const changeRegistration = subscriptionData.changeEvent.register(changeCallback);
			const deleteRegistration = subscriptionData.deleteEvent.register(deleteCallback);
			const triggerRegistration = subscriptionData.triggerEvent.register(triggerCallback);

			return Disposable.fromAction(() => {
				subscriptionData.subscribers = subscriptionData.subscribers - 1;

				if (subscriptionData.subscribers === 0) {
					subscriptionData.implementationBinding.dispose();
				}

				createRegistration.dispose();
				changeRegistration.dispose();
				deleteRegistration.dispose();
				triggerRegistration.dispose();
			});
		}

		/**
		 * Creates a new alert.
		 *
		 * @public
		 * @param {Schema.Alert} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		createAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'create alert');

					validate.alert.forCreate(alert);
				}).then(() => {
					return Promise.all([
						this.getProperties(),
						this.getOperators()
					]);
				}).then((results) => {
					const properties = results[0];
					const operators = results[1];

					const propertyMap = alert.conditions.reduce((map, c) => {
						const property = properties.find((p) => p.property_id === c.property.property_id);

						map[property.property_id] = property;

						return map;
					}, { });

					const operatorMap = alert.conditions.reduce((map, c) => {
						const operator = operators.find((o) => o.operator_id === c.operator.operator_id);

						map[operator.operator_id] = operator;

						return map;
					}, { });

					const instrumentMap = alert.conditions.reduce((map, c) => {
						const property = propertyMap[c.property.property_id];

						if (property.target.type === 'symbol') {
							const symbol = c.property.target.identifier;

							if (!map.hasOwnProperty(symbol)) {
								map[symbol] = lookupInstrument(symbol);
							}
						}

						return map;
					}, { });

					return Promise.all(alert.conditions.map((c, i) => {
						let validatePromise;

						const property = propertyMap[c.property.property_id];
						const operator = operatorMap[c.operator.operator_id];

						if (property.target.type === 'symbol') {
							const symbol = c.property.target.identifier;

							validatePromise = instrumentMap[symbol]
								.then((result) => {
									const instrument = result.instrument;
									const unitcode = convertBaseCodeToUnitCode(instrument.unitcode);

									validate.instrument.forCreate(symbol, instrument);

									if (property.format === 'price' && operator.operand_type === 'number' && operator.operand_literal) {
										let operandToParse = c.operator.operand;

										if (is.string(operandToParse) && operandToParse.match(/^(-?)([0-9,]+)$/) !== null) {
											operandToParse = operandToParse + '.0';
										}

										const price = valueParser(operandToParse, unitcode, ',');

										if (!is.number(price)) {
											throw new Error('Condition ' + i + ' is invalid. The price cannot be parsed.');
										}

										c.operator.operand_display = c.operator.operand;
										c.operator.operand_format = formatPrice(price, unitcode, '-', false, ',');
										c.operator.operand = price;
									}
								});
						} else {
							validatePromise = Promise.resolve();
						}

						return validatePromise;
					}));
				}).then(() => {
					return this._adapter.createAlert(alert);
				});
		}

		/**
		 * Performs a synthetic update operation on an existing alert. The
		 * existing alert is deleted. Then, a new alert is created in its
		 * place. The new alert will have the same identifier.
		 *
		 * @public
		 * @param {Schema.Alert} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		editAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'edit alert');

					validate.alert.forEdit(alert);
				}).then(() => {
					return this.deleteAlert(alert);
				}).then(() => {
					return this.createAlert(alert);
				});
		}

		/**
		 * Deletes an existing alert.
		 *
		 * @public
		 * @param {Schema.Alert} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		deleteAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'delete alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					return this._adapter.deleteAlert({alert_id: alert.alert_id});
				});
		}

		/**
		 * Sends a request to transition an alert to the ```Active``` state.
		 *
		 * @public
		 * @param {Schema.Alert|Schema.AlertIdentifier} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		enableAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'enable alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					const clone = Object.assign({ }, alert);
					clone.alert_state = 'Starting';

					onAlertMutated.call(this, clone);

					return this._adapter.updateAlert({alert_id: alert.alert_id, alert_state: 'Starting'});
				});
		}

		/**
		 * Sends a request to transition all alerts owned by a user to the ```Active``` state.
		 *
		 * @public
		 * @param {Schema.AlertQuery} query
		 * @returns {Promise<Boolean>}
		 */
		enableAlerts(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'enable alerts');

					validate.alert.forUser(query);

					return this._adapter.updateAlertsForUser({user_id: query.user_id, alert_system: query.alert_system, alert_state: 'Starting'});
				}).then(() => {
					return true;
				});
		}

		/**
		 * Sends a request to transition an alert to the ```Inactive``` state.
		 *
		 * @public
		 * @param {Schema.Alert|Schema.AlertIdentifier} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		disableAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'disable alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					const clone = Object.assign({ }, alert);
					clone.alert_state = 'Stopping';

					onAlertMutated.call(this, clone);

					return this._adapter.updateAlert({alert_id: alert.alert_id, alert_state: 'Stopping'});
				});
		}

		/**
		 * Sends a request to transition all alerts owned by a user to the ```Inactive``` state.
		 *
		 * @public
		 * @param {Schema.AlertQuery} query
		 * @returns {Promise<Boolean>}
		 */
		disableAlerts(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'disable alerts');

					validate.alert.forUser(query);

					return this._adapter.updateAlertsForUser({user_id: query.user_id, alert_system: query.alert_system, alert_state: 'Stopping'});
				}).then(() => {
					return true;
				});
		}

		/**
		 * Gets a set of alert triggers, matching query criteria.
		 *
		 * @public
		 * @param {Object} query
		 * @param {String} query.user_id
		 * @param {String} query.alert_system
		 * @param {String=} query.trigger_date
		 * @param {String=} query.trigger_status
		 * @returns {Promise<Schema.Trigger[]>}
		 */
		retrieveTriggers(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'retrieve alert triggers');

					validate.trigger.forQuery(query);
				}).then(() => {
					return this._adapter.retrieveTriggers(query);
				});
		}

		/**
		 * Registers three separate callbacks which will be invoked when triggers are created,
		 * deleted, changed.
		 *
		 * @public
		 * @param {Object} query
		 * @param {String} query.user_id
		 * @param {String} query.alert_system
		 * @param {Callbacks.TriggersMutatedCallback} changeCallback
		 * @param {Callbacks.TriggersDeletedCallback} deleteCallback
		 * @param {Callbacks.TriggersCreatedCallback} createCallback
		 * @returns {Disposable}
		 */
		subscribeTriggers(query, changeCallback, deleteCallback, createCallback) {
			checkStatus(this, 'subscribe triggers');

			validate.trigger.forUser(query);

			assert.argumentIsRequired(changeCallback, 'changeCallback', Function);
			assert.argumentIsRequired(deleteCallback, 'deleteCallback', Function);
			assert.argumentIsRequired(createCallback, 'createCallback', Function);

			const userId = query.user_id;
			const alertSystem = query.alert_system;

			if (!this._triggerSubscriptionMap.hasOwnProperty(userId)) {
				this._triggerSubscriptionMap[userId] = {};
			}

			if (!this._triggerSubscriptionMap[userId].hasOwnProperty(alertSystem)) {
				this._triggerSubscriptionMap[userId][alertSystem] = {
					createEvent: new Event(this),
					changeEvent: new Event(this),
					deleteEvent: new Event(this),
					subscribers: 0
				};
			}

			const subscriptionData = this._triggerSubscriptionMap[userId][alertSystem];

			if (subscriptionData.subscribers === 0) {
				subscriptionData.implementationBinding = this._adapter.subscribeTriggers(query);
			}

			subscriptionData.subscribers = subscriptionData.subscribers + 1;

			const createRegistration = subscriptionData.createEvent.register(createCallback);
			const changeRegistration = subscriptionData.changeEvent.register(changeCallback);
			const deleteRegistration = subscriptionData.deleteEvent.register(deleteCallback);

			return Disposable.fromAction(() => {
				subscriptionData.subscribers = subscriptionData.subscribers - 1;

				if (subscriptionData.subscribers === 0) {
					subscriptionData.implementationBinding.dispose();
				}

				createRegistration.dispose();
				changeRegistration.dispose();
				deleteRegistration.dispose();
			});
		}

		/**
		 * Updates the status (i.e. read/unread) for a single alert trigger.
		 *
		 * @public
		 * @param {Object} query
		 * @param {String} query.alert_id
		 * @param {String} query.trigger_date
		 * @param {String=} query.trigger_status
		 * @returns {Promise<Schema.Trigger>}
		 */
		updateTrigger(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'updates alert trigger');

					validate.trigger.forUpdate(query);
				}).then(() => {
					return this._adapter.updateTrigger(query);
				});
		}

		/**
		 * Updates the status (i.e. read/unread) for all alert triggers which match
		 * the query criteria.
		 *
		 * @public
		 * @param {Object} query
		 * @param {String} query.user_id
		 * @param {String} query.alert_system
		 * @param {String=} query.trigger_status
		 * @returns {Promise<Schema.Trigger[]>}
		 */
		updateTriggers(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'updates alert triggers');

					validate.trigger.forBatch(query);
				}).then(() => {
					return this._adapter.updateTriggers(query);
				});
		}

		/**
		 * Gets all templates owned by the current user.
		 *
		 * @public
		 * @param {Schema.TemplateQuery} query
		 * @returns {Promise<Schema.Template[]>}
		 */
		retrieveTemplates(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get templates');

					validate.template.forUser(query);
				}).then(() => {
					return this._adapter.getTemplates(query);
				});
		}

		/**
		 * Creates a new template.
		 *
		 * @public
		 * @param {Schema.Template} template
		 * @returns {Promise<Schema.Template>}
		 */
		createTemplate(template) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'create template');

					validate.template.forCreate(template);
				}).then(() => {
					return this._adapter.createTemplate(template);
				});
		}

		/**
		 * Deletes an existing template.
		 *
		 * @public
		 * @param {Schema.Template} template
		 * @returns {Promise<Schema.Template>}
		 */
		deleteTemplate(template) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'delete template');

					validate.template.forQuery(template);
				}).then(() => {
					return this._adapter.deleteTemplate({ template_id: template.template_id });
				});
		}

		/**
		 * When constructing alert conditions, we often refer to a stock by
		 * its symbol. This function will validate the symbol before you
		 * attempt to assign it to the ```identifier``` property of a
		 * ```Target``` object. In some cases, an alternate (alias) symbol
		 * will be returned. If the symbol returned is different, you must
		 * use the alternate symbol.
		 *
		 * @public
		 * @param {String} symbol - The symbol to check
		 * @returns {Promise<String>}
		 */
		checkSymbol(symbol) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'check symbol');

					return lookupInstrument(symbol);
				}).then((result) => {
					validate.instrument.forCreate(symbol, result.instrument);

					return result.instrument.symbol;
				});
		}

		/**
		 * Retrieves the entire list of targets which are available to the
		 * system.
		 *
		 * @public
		 * @returns {Promise<Schema.Target[]>}
		 */
		getTargets() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get targets');

					return this._adapter.getTargets();
				});
		}

		/**
		 * Retrieves the entire list of properties which are available to the
		 * system.
		 *
		 * @public
		 * @returns {Promise<Schema.Property[]>}
		 */
		getProperties() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get properties');

					return this._adapter.getProperties();
				});
		}

		/**
		 * Retrieves the entire list of operators which are available to the
		 * system.
		 *
		 * @public
		 * @returns {Promise<Schema.Operator[]>}
		 */
		getOperators() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get operators');

					return this._adapter.getOperators();
				});
		}

		getModifiers() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get modifiers');

					return this._adapter.getModifiers();
				});
		}

		/**
		 * Retrieves the entire list of strategies that can be used to notify
		 * users when an alert is triggered.
		 *
		 * @public
		 * @returns {Promise<Schema.PublisherType[]>}
		 */
		getPublisherTypes() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get publisher types');

					return this._adapter.getPublisherTypes();
				});
		}

		/**
		 * Retrieves the notification preferences for a user.
		 *
		 * @public
		 * @param {Object} query
		 * @param {String} query.user_id
		 * @param {String} query.alert_system
		 * @returns {Promise<Schema.PublisherTypeDefault[]>}
		 */
		getPublisherTypeDefaults(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get publisher type defaults');

					validate.publisherTypeDefault.forUser(query);
				}).then(() => {
					return this._adapter.getPublisherTypeDefaults(query);
				});
		}

		/**
		 * Saves a user's notification preferences for a single notification strategy (e.g. email
		 * or text message).
		 *
		 * @public
		 * @param {Schema.PublisherTypeDefault} publisherTypeDefault
		 * @returns {Promise<Schema.PublisherTypeDefault>}
		 */
		assignPublisherTypeDefault(publisherTypeDefault) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'assign publisher type default');

					validate.publisherTypeDefault.forCreate(publisherTypeDefault);
				}).then(() => {
					return this._adapter.assignPublisherTypeDefault(publisherTypeDefault);
				});
		}

		getMarketDataConfiguration(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get market data configuration');
				}).then(() => {
					return this._adapter.getMarketDataConfiguration(query);
				});
		}

		assignMarketDataConfiguration(marketDataConfiguration) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'assign market data configuration');
				}).then(() => {
					return this._adapter.assignMarketDataConfiguration(marketDataConfiguration);
				});
		}

		/**
		 * Returns the version number of the remote service you are connected to.
		 *
		 * @public
		 * @returns {Promise<String>}
		 */
		getServerVersion() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get server version');
				}).then(() => {
					return this._adapter.getServerVersion();
				});
		}

		/**
		 * Returns the current user (according to the JWT token which is embedded
		 * in the request).
		 *
		 * @public
		 * @returns {Promise<Schema.UserIdentifier>}
		 */
		getUser() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get authenticated user');
				}).then(() => {
					return this._adapter.getUser();
				});
		}

		/**
		 * Creates an alert object from template and symbol identifier.
		 *
		 * @public
		 * @static
		 * @param {Schema.Template} template
		 * @param {String} symbol
		 * @param {Schema.Alert=} alert
		 * @returns {Promise<Schema.Alert>}
		 */
		static createAlertFromTemplate(template, symbol, alert) {
			const newAlert = { };

			if (is.object(alert)) {
				const properties = [ 'alert_type', 'alert_behavior', 'automatic_reset', 'user_notes' ];

				properties.forEach((property) => {
					if (alert.hasOwnProperty(property)) {
						newAlert[property] = object.clone(alert[property]);
					}
				});
			}

			if (template.user_id) {
				newAlert.user_id = template.user_id;
			}

			if (template.alert_system) {
				newAlert.alert_system = template.alert_system;
			}

			newAlert.conditions = template.conditions.map((c) => {
				const condition = object.clone(c);

				const property = condition.property;

				property.target = { };
				property.target.identifier = symbol;

				return condition;
			});

			return newAlert;
		}

		static getPropertiesForTarget(properties, target) {
			return properties.filter((property) => property.target.target_id === target.target_id);
		}

		static getOperatorsForProperty(operators, property) {
			const operatorMap = AlertManager.getOperatorMap(operators);

			return property.valid_operators.map((operatorId) => operatorMap[operatorId]);
		}

		static getPropertyTree(properties, short) {
			let descriptionSelector;

			if (is.boolean(short) && short) {
				descriptionSelector = p => p.descriptionShort;
			} else {
				descriptionSelector = p => p.description;
			}

			const root = properties.reduce((tree, property) => {
				const descriptionPath = (property.category || [ ]).concat(descriptionSelector(property) || [ ]);
				const descriptionPathLast = descriptionPath.length - 1;

				let node = tree;

				descriptionPath.forEach((description, i) => {
					node.items = node.items || [ ];

					let child = node.items.find((candidate) => candidate.description === description);

					if (!child) {
						let sortOrder;

						if (i === descriptionPathLast && typeof(property.sortOrder) === 'number') {
							sortOrder = property.sortOrder;
						} else {
							sortOrder = property.sortOrder;
						}

						child = {
							description: description,
							sortOrder: sortOrder
						};

						node.items.push(child);
					}

					node = child;
				});

				node.item = property;

				return tree;
			}, { });

			const sortTree = (node) => {
				if (!Array.isArray(node.items)) {
					return;
				}

				node.items.sort((a, b) => {
					let returnVal = a.sortOrder - b.sortOrder;

					if (returnVal === 0) {
						returnVal = a.description.localeCompare(b.description);
					}

					return returnVal;
				});

				node.items.forEach((child) => {
					sortTree(child);
				});
			};

			sortTree(root);

			return root.items;
		}

		static getPropertyMap(properties) {
			return array.indexBy(properties, (property) => property.property_id);
		}

		static getOperatorMap(operators) {
			return array.indexBy(operators, (operator) => operator.operator_id);
		}

		/**
		 * Returns the version of the SDK.
		 *
		 * @public
		 * @static
		 * @returns {String}
		 */
		static get version() {
			return version;
		}

		/**
		 * Creates and starts a new {@link AlertManager} for use in the private staging environment.
		 *
		 * @public
		 * @static
		 * @param {JwtProvider} jwtProvider
		 * @param {AdapterBase} adapterClazz
		 * @returns {Promise<AlertManager>}
		 */
		static forStaging(jwtProvider, adapterClazz) {
			return Promise.resolve()
				.then(() => {
					assert.argumentIsRequired(jwtProvider, 'jwtProvider', JwtProvider, 'JwtProvider');
					assert.argumentIsRequired(adapterClazz, 'adapter', Function);

					return start(new AlertManager(Configuration.stagingHost, DEFAULT_SECURE_PORT, true, adapterClazz), jwtProvider);
				});
		}

		/**
		 * Creates and starts a new {@link AlertManager} for use in the private production environment.
		 *
		 * @public
		 * @static
		 * @param {JwtProvider} jwtProvider
		 * @param {AdapterBase} adapterClazz
		 * @returns {Promise<AlertManager>}
		 */
		static forProduction(jwtProvider, adapterClazz) {
			return Promise.resolve()
				.then(() => {
					assert.argumentIsRequired(jwtProvider, 'jwtProvider', JwtProvider, 'JwtProvider');
					assert.argumentIsRequired(adapterClazz, 'adapter', Function);

					return start(new AlertManager(Configuration.productionHost, DEFAULT_SECURE_PORT, true, adapterClazz), jwtProvider);
				});
		}

		/**
		 * Creates and starts a new {@link AlertManager} for use in the private admin environment.
		 *
		 * @public
		 * @static
		 * @param {JwtProvider} jwtProvider
		 * @param {AdapterBase} adapterClazz
		 * @returns {Promise<AlertManager>}
		 */
		static forAdmin(jwtProvider, adapterClazz) {
			return Promise.resolve()
				.then(() => {
					assert.argumentIsRequired(jwtProvider, 'jwtProvider', JwtProvider, 'JwtProvider');
					assert.argumentIsRequired(adapterClazz, 'adapter', Function);

					return start(new AlertManager(Configuration.adminHost, DEFAULT_SECURE_PORT, true, adapterClazz), jwtProvider);
				});
		}

		/**
		 * Creates and starts a new {@link AlertManager} for use in the private demo environment.
		 *
		 * @public
		 * @static
		 * @param {JwtProvider} jwtProvider
		 * @param {AdapterBase} adapterClazz
		 * @returns {Promise<AlertManager>}
		 */
		static forDemo(jwtProvider, adapterClazz) {
			return Promise.resolve()
				.then(() => {
					assert.argumentIsRequired(jwtProvider, 'jwtProvider', JwtProvider, 'JwtProvider');
					assert.argumentIsRequired(adapterClazz, 'adapter', Function);

					return start(new AlertManager(Configuration.demoHost, DEFAULT_SECURE_PORT, true, adapterClazz), jwtProvider);
				});
		}

		_onDispose() {
			if (this._adapter) {
				this._adapter.dispose();
				this._adapter = null;
			}

			this._alertSubscriptionMap = null;
		}

		toString() {
			return '[AlertManager]';
		}
	}

	function start(gateway, jwtProvider) {
		return gateway.connect(jwtProvider)
			.then(() => {
				return gateway;
			});
	}

	function getMutationEvents(map, alert) {
		let returnRef = null;

		const userId = alert.user_id;
		const alertSystem = alert.alert_system;

		if (map.hasOwnProperty(userId)) {
			const systemMap = map[userId];

			if (systemMap.hasOwnProperty(alertSystem)) {
				returnRef = systemMap[alertSystem];
			}
		}

		return returnRef;
	}

	function checkDispose(manager, operation) {
		if (manager.getIsDisposed()) {
			throw new Error(`Unable to perform ${operation}, the alert manager has been disposed`);
		}
	}

	function checkStatus(manager, operation) {
		checkDispose(manager, operation);

		if (manager._adapter === null) {
			throw new Error(`Unable to perform ${operation}, the alert manager has not connected to the server`);
		}
	}

	function onAlertCreated(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, alert);

		if (data) {
			data.createEvent.fire(cloneAlert(alert));
		}
	}

	function onAlertMutated(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, cloneAlert(alert));

		if (data) {
			data.changeEvent.fire(alert);
		}
	}

	function onAlertDeleted(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, cloneAlert(alert));

		if (data) {
			data.deleteEvent.fire(alert);
		}
	}

	function onAlertTriggered(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, cloneAlert(alert));

		if (data) {
			data.triggerEvent.fire(alert);
		}
	}

	function onTriggersCreated(triggers) {
		if (!triggers || triggers.length === 0) {
			return;
		}

		const data = getMutationEvents(this._triggerSubscriptionMap, triggers[0]);

		if (data) {
			data.createEvent.fire(triggers);
		}
	}

	function onTriggersMutated(triggers) {
		if (!triggers || triggers.length === 0) {
			return;
		}

		const data = getMutationEvents(this._triggerSubscriptionMap, triggers[0]);

		if (data) {
			data.changeEvent.fire(triggers);
		}
	}

	function onTriggersDeleted(triggers) {
		if (!triggers || triggers.length === 0) {
			return;
		}

		const data = getMutationEvents(this._triggerSubscriptionMap, triggers[0]);

		if (data) {
			data.deleteEvent.fire(triggers);
		}
	}

	function cloneAlert(alert) {
		return alert;
	}

	const instrumentLookupEndpoint = EndpointBuilder.for('lookup-instrument', 'lookup instrument')
		.withVerb(VerbType.GET)
		.withProtocol(ProtocolType.HTTPS)
		.withHost('instruments-prod.aws.barchart.com')
		.withPort(DEFAULT_SECURE_PORT)
		.withPathBuilder((pb) => {
			pb.withLiteralParameter('instruments', 'instruments')
				.withVariableParameter('symbol', 'symbol', 'symbol');
		})
		.withResponseInterceptor(ResponseInterceptor.DATA)
		.withErrorInterceptor(ErrorInterceptor.GENERAL)
		.endpoint;

	function lookupInstrument(symbol) {
		return Gateway.invoke(instrumentLookupEndpoint, { symbol: symbol });
	}

	return AlertManager;
})();
