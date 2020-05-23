## Synopsis

The Barchart Alert Service communicates using JSON data. We send JSON objects to the backend and we receive JSON objects in response.

The top-level object is called an  _"alert"_. Here is a visualization of an alert, showing important component structures:

```text
├── Alert
│   ├── Condition(s)
│   │   ├── Property
│   │   │   └── Target
│   │   ├── Operator
│   │   │   └── Operand
│   ├── Publisher(s)
```

Consider an alert with a condition for _Apple stock's last price is greater than $600_. Using this alert, let's extend the previous visualization:

 ```text
 ├── Alert
 │   ├── Condition 1:
 │   │   ├── Property: (Last Price)
 │   │   │   └── Target: (AAPL)
 │   │   ├── Operator: (Greater Than)
 │   │   │   └── Operand: ($600)
 ```

 Here is the JSON object representing the same alert:

```json
{
	"user_id": "me",
	"alert_system": "barchart.com",
	"name": "My First Alert"
	"conditions": [
		{
			"property": {
				"property_id": 1,
				"target": {
					"identifier": "AAPL"
				}
			},
			"operator": {
				"operator_id": 2,
				"operand": "600"
			}
		}
	]
}
```

## Building Conditions

In order to build conditional statements, you'll need the list of available _"target"_, _"property"_, and _"operator"_ objects. Request them as follows:

```js
const promises = [
	alertManager.getTargets(),
	alertManager.getProperties(),
	alertManager.getOperators()
];

return Promise.all(promises)
	.then(results) => {
		const availableTargets = results[0];
		const availableProperties = results[1];
		const availableOperators = results[3];
	});
```

If you're building an interactive application, you'll need this metadata to build a dynamic UI — allowing your users to define their own conditions. For example, our sample application allows users to define their own conditions (see the [Quick Start: Sample Applications](/content/quick_start?id=sample-applications) section for loading instructions).

### Natural Language Text

At present, you must construct JSON objects which conform to the [Condition]() schema. However, natural language conditional statements will be supported soon. As of yet, the syntax is has not been finalized; however, it will look something like this:

* "AAPL.last-price > 600"
* "AAPL.bid-size < AAPL.ask-size"

## Structure Glossary

### Alert

_Refer to [```Schema.Alert```](/content/sdk/lib-data?id=schemaalert) for a formal definition._

**An "alert" is essentially a container for conditions.** It has an owner. It always exists in one state (e.g.inactive, started, triggered). All conditions must evaluate to true before the alert will trigger.

Here is an object — using the fewest fields necessary — to create a new alert:

```json (psuedo)
{
	"user_id": "me",
	"alert_system": "barchart.com",
	"name": "My First Alert"
	"conditions": [ /* See below */ ]
}
```

### Condition

_Refer to [```Schema.Condition```](/content/sdk/lib-data?id=schemacondition) for a formal definition._

**A "condition" is a statement that is evaluated by the backend (as streaming data is processed).** For example, "Apple stock's last price is higher than $600" is a condition. A "condition" belongs to an alert.

Here is an object — using the fewest fields necessary — to create a condition (for use with a new alert):

```json (psuedo)
{
	"property": { /* See below */ },
	"operator": { /* See below */ }
}
```

### Property

_Refer to [```Schema.Property```](/content/sdk/lib-data?id=schemaproperty) for a formal definition._

**A "property" is an attribute of a "condition" referring to a streaming data source** including a target. For example, the **last price** of a stock quote is a property. Then, specifying Apple stock, as opposed to some other company, is the target.

Here is an object — using the fewest fields necessary — to create a property (for use with a new alert):

```json (psuedo)
{
	"property_id": 1,
	"target": { /* See below */ }
}
```

### Target

_Refer to [```Schema.Target```](/content/sdk/lib-data?id=schematarget) for a formal definition._

**A "target" identifies a specific entity.** For example, Apple stock is a target and Microsoft stock is a another target. Each uses a different ```identifier``` property value. Targets are included on property object.

Here is an object — using the fewest fields necessary — to create a target (for use with a new alert):

```json
{
	"identifier": "AAPL"
}
```

### Operator

_Refer to [```Schema.Operator```](/content/sdk/lib-data?id=schemaoperator) for a formal definition._

**An operator refers to type of comparison.** For example, _"greater than"_, _"less than"_, and _"equals"_ are three different types of operators. Operator objects include an ```operand``` property to complete the right-hand side of an expression (e.g. "greater than $600").

Here is an object — using the fewest fields necessary — to create a operator (for use with a new alert):

```json
{
	"operator_id": 2,
	"operand": "600"
}
```

### Publisher

_Refer to [```Schema.Publisher```](/content/sdk/lib-data?id=schemapublisher) for a formal definition._

**A publisher defines a set of rules for notifying the owner of an alert.**

