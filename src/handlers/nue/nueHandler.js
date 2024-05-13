import { DB, dropDb, describeDatabase, createDb } from 'nuedb_core';
import { verifySyntax } from '../syntaxHandler.js';
import { clean } from "../../utils/string.js";
import { createNueResponse } from './messageHandler.js';

let currentDB = 'placeholder';
const sysDB = new DB();
let dbName = ''
let result;

export async function handleNueRequest(headers, body) {
    try {
        handlePreRequestHeaders(headers);
        if (body) {
            const allRequests = body.split(';')
            const allResponses = []
            for (const req of allRequests) {
                allResponses.push(await executeCommand(req))
            }
            const finalRes = createNueResponse({ Status: "OK" }, allResponses);
            handlePostRequestHeaders(headers);
            return finalRes;
        }
        const res = createNueResponse({ Status: "OK" });
        handlePostRequestHeaders(headers);
        return res;
    } catch (err) {
        return createNueResponse({ Status: "ERROR" }, [err.message]);
    }
}

async function handlePreRequestHeaders(headers) {
    for (const header in headers) {
        switch (header) {
            case "HandShake":

                break;
        }
    }
}

async function handlePostRequestHeaders(headers) {
    for (const header in headers) {
        switch (header) {
            case "Save":
                if (currentDB instanceof DB) {
                    await currentDB.save();
                }
                await sysDB.save();

                break;
        }
    }
}

export async function executeCommand(rawCommand) {

    await sysDB.init('system', 'nue');

    let { commandMatch, command } = verifySyntax(rawCommand);

    const commandParts = command.split(' ');
    const action = commandParts[0].toUpperCase().trim();
    const tableName = commandParts[2];

    switch (action) {
        case 'INIT':
            if (currentDB instanceof DB) {
                await currentDB.save();
            }

            dbName = commandParts[1].split(';').shift();
            currentDB = new DB();
            const init = await currentDB.init('data', dbName);
            if (init) {
                result = `Using database: ${dbName}`;
            } else {
                throw new Error(`Database ${dbName} doesn't exist.`);
            }
            break;

        case 'CREATE':

            const element = commandMatch[1];
            const elementName = commandMatch[2].trim();

            let parameters = commandMatch[3];

            if (element && (element.toUpperCase() === 'DATABASE' || element.toUpperCase() === 'DB')) {
                if (parameters) {
                    throw new Error('Unexpected parameters on "CREATE DATABASE" instruction.');
                }

                await sysDB.insert({ tableName: 'database', values: [elementName] })

                result = await createDb('data', elementName);

            } else if (element && (element.toUpperCase() === 'TABLE' || element.toUpperCase() === 'TB')) {
                if (!(currentDB instanceof DB)) {
                    throw new Error('No database intialized. Use "INIT <database_name>" to initialize a database.');
                }
                if (!parameters) {
                    throw new Error('No parameters specified for create table command.')
                }
                parameters = parameters.split(',');
                let primaryKeyCount = 0;
                let pk, pkPos;
                for (let i = 0; i < parameters.length; i++) {
                    const pkMatch = parameters[i].match(/^\s*(\w+)\s+as\s+primary_key\s*$/ui);
                    if (pkMatch) {
                        primaryKeyCount++;
                        pk = pkMatch[1]
                        pkPos = i;
                    } else {
                        parameters[i] = parameters[i].trim();
                    }
                }
                if (primaryKeyCount > 0) {
                    parameters.splice(pkPos, 1)
                }
                if (primaryKeyCount > 1) {
                    throw new Error('Unable to specify more than one primary key by table.')
                }

                result = await currentDB.createTable({ tableName: elementName, primaryKey: pk, columns: parameters })
            }

            break;

        case 'INSERT':
            if (!(currentDB instanceof DB)) {
                throw new Error('No database intialized. Use "INIT <database_name>" to initialize a database.');
            }

            const insertColumns = commandMatch[1];
            const insertValues = commandMatch[2];

            const cleanValues = (values) => {
                const regex = /(?:'([^']+)'|"([^"]+)")|([^,]+)/g;
                const matches = values.matchAll(regex);
                const cleanedValues = [];
                for (const match of matches) {
                    const value = match[0] || match[1] || match[2];
                    cleanedValues.push(clean(value.trim()));
                }
                return cleanedValues;
            };

            if (insertValues === undefined) {
                const valuesIndex = command.search(/\bVALUES\b/ui);
                if (valuesIndex !== -1) {
                    throw new Error('INSERT command requires a VALUES clause with parameters.');
                }
                const cleanedValues = cleanValues(insertColumns);
                result = await currentDB.insert({ tableName, values: cleanedValues });
            } else {
                const cleanedColumns = insertColumns.split(',').map(value => clean(value.trim()));
                const cleanedValues = cleanValues(insertValues);
                result = await currentDB.insert({ tableName, columns: cleanedColumns, values: cleanedValues });
            }
            break;

        case 'FIND':
            if (!(currentDB instanceof DB)) {
                throw new Error('No database initialized. Use "INIT <database_name>" to initialize a database.');
            }

            const findQueryObject = {
                distinct: Boolean(commandMatch[1]),
                columns: commandMatch[2] === '*' ? undefined : commandMatch[2].split(',').map(column => column.trim()),
                tableName: commandMatch[3],
                condition: commandMatch[5],
                operator: commandMatch[6],
                orderBy: commandMatch[8],
                limit: commandMatch[10],
                offset: commandMatch[11]
            }

            if (commandMatch[4]) {
                const joins = commandMatch[4].split(/\w+\s*\sjoin\s\s*/i).splice(1).map(join => {
                    const divisorElement = join.split(/\s*\son\s\s*/i);
                    const joinElement = {
                        referenceTable: [...divisorElement].shift(),
                        firstColumn: [...divisorElement].pop().split('=').shift().trim(),
                        secondColumn: [...divisorElement].pop().split('=').pop().trim(),
                    }
                    return joinElement
                });
                findQueryObject.joins = joins;
            }

            // Asignación de valor de la condición si es usada la variable PRIMARY_KEY
            if (findQueryObject.condition === 'PRIMARY_KEY') {
                findQueryObject.condition = undefined;
            }

            // Asignación de valores dependiendo del operador. Si es IN o NOT IN deberá expresarse como un array de elementos, si no, como valores normales (string, number, boolean...).
            if (findQueryObject.operator) {
                if (findQueryObject.operator.toUpperCase() === 'IN' || findQueryObject.operator.toUpperCase() === 'NOT IN') {
                    findQueryObject.conditionValue = commandMatch[7].replace(/\(|\)/g, '').split(',').map(value => clean(value.trim()));
                } else {
                    findQueryObject.conditionValue = clean(commandMatch[7]);
                }
            }

            // Asignación de valor asociado al match que representa la orientación del ordenamiento (ORDER BY) del FIND
            if (commandMatch[9] === undefined || commandMatch[9].toUpperCase() === 'ASC') {
                findQueryObject.asc = true;
            } else {
                findQueryObject.asc = false;
            }

            result = await currentDB.find(findQueryObject);
            break;

        case 'DESCRIBE':
        case 'LS':

            const describeElement = commandParts[1];
            if (!commandParts[2]) {
                throw new Error("No parameter specified for describe command.")
            }
            switch (describeElement.toUpperCase()) {

                case 'TABLE':
                case 'TB':
                    if (!(currentDB instanceof DB)) {
                        throw new Error('No database intialized. Use "INIT <database_name>" to initialize a database.');
                    }

                    result = currentDB.describeOneTable(commandParts[2].trim());
                    break;
                case 'DATABASE':
                case 'DB':

                    result = describeDatabase(currentDB, commandParts[2].trim())
                    break;
            }
            break;

        case 'SHOW':

            const likeClause = commandMatch[1];

            if(likeClause) {
                result = sysDB.find({
                    tableName: 'database',
                    condition: 'name',
                    operator: 'LIKE',
                    conditionValue: likeClause.trim()
                })
            }else {
                result = sysDB.find({
                    tableName: 'database'
                })
            }

        break;

        case 'DROP':

            const dropElement = commandParts[1];

            switch (dropElement.toUpperCase()) {
                case 'DATABASE':
                case 'DB':

                    await sysDB.delete({
                        tableName: 'database',
                        condition: 'name',
                        operator: '=',
                        conditionValue: commandParts[2].trim()
                    });

                    result = await dropDb('data', commandParts[2].trim());
                    break;
                case 'TABLE':
                case 'TB':
                    if (!(currentDB instanceof DB)) {
                        throw new Error('No database intialized. Use "INIT <database_name>" to initialize a database.');
                    }

                    result = await currentDB.dropTable(commandParts[2].trim());
                    break;
            }
            break;

        case 'DELETE':
            if (!(currentDB instanceof DB)) {
                throw new Error('No database initialized. Use "INIT <database_name>" to initialize a database.');
            }

            const deleteMatch = commandMatch;

            const deleteTableName = deleteMatch[1];
            const deleteWhereField = deleteMatch[2];
            const deleteOperator = deleteMatch[3];
            let deleteConditionValue;

            if (deleteMatch[4]) {
                if (deleteOperator.toUpperCase() === 'IN' || deleteOperator.toUpperCase() === 'NOT IN') {
                    deleteConditionValue = deleteMatch[4].replace(/\(|\)/g, '').split(',').map(value => clean(value.trim()));
                } else {
                    deleteConditionValue = clean(deleteMatch[4]);
                }
            } else {
                throw new Error('You must specify a condition value for WHERE clause.');
            }

            if (deleteWhereField === 'PRIMARY_KEY') {
                result = await currentDB.delete({
                    tableName: deleteTableName,
                    condition: undefined,
                    operator: deleteOperator,
                    conditionValue: deleteConditionValue
                });
            } else {
                result = await currentDB.delete({
                    tableName: deleteTableName,
                    condition: deleteWhereField,
                    operator: deleteOperator,
                    conditionValue: deleteConditionValue
                });
            }
            break;

        case 'UPDATE':
            if (!(currentDB instanceof DB)) {
                throw new Error('No database initialized. Use "INIT <database_name>" to initialize a database.');
            }

            const updateMatch = commandMatch;

            const updateTableName = updateMatch[1];
            const setClause = updateMatch[2];
            const updateCondition = updateMatch[3];
            const updateOperator = updateMatch[4];
            let updateConditionValue;

            if (updateOperator.toUpperCase() === 'IN' || updateOperator.toUpperCase() === 'NOT IN') {
                updateConditionValue = updateMatch[5].replace(/\(|\)/g, '').split(',').map(value => clean(value.trim()));
            } else {
                updateConditionValue = clean(updateMatch[5]);
            }

            // Parse SET clause
            const setKeyValuePairs = setClause.match(/\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^'",]*)/g) || [];
            const setArray = setKeyValuePairs.map(entry => entry.split('=').shift().trim());
            const setValuesArray = setKeyValuePairs.map(entry => clean(entry.split('=').pop().trim()));

            // Apply additional cleaning for SET values
            const cleanedSetValuesArray = setValuesArray.map(value => {
                if (/^['"]/.test(value) && /['"]$/.test(value)) {
                    return value.slice(1, -1).replace(/\\(["'])/g, "$1");
                } else {
                    return value;
                }
            });

            // Perform the update operation
            if (updateCondition === 'PRIMARY_KEY') {
                result = await currentDB.update({
                    tableName: updateTableName,
                    set: setArray,
                    setValues: cleanedSetValuesArray,
                    condition: undefined,
                    operator: updateOperator,
                    conditionValue: updateConditionValue
                });
            } else {
                result = await currentDB.update({
                    tableName: updateTableName,
                    set: setArray,
                    setValues: cleanedSetValuesArray,
                    condition: updateCondition,
                    operator: updateOperator,
                    conditionValue: updateConditionValue
                });
            }
            break;

        default:
            throw new Error('Invalid command action');
    }

    return result;

}
