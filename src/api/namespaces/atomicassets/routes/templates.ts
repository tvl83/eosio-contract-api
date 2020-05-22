import * as express from 'express';

import { AtomicAssetsNamespace } from '../index';
import { HTTPServer } from '../../../server';
import { buildDataConditions, getLogs } from '../utils';
import { filterQueryArgs } from '../../utils';
import logger from '../../../../utils/winston';
import { formatTemplate } from '../format';
import { standardArrayFilter } from '../swagger';

export function templatesEndpoints(core: AtomicAssetsNamespace, _: HTTPServer, router: express.Router): any {
    async function templateRequestHandler(req: express.Request, res: express.Response): Promise<any> {
        try {
            const args = filterQueryArgs(req, {
                page: {type: 'int', min: 1, default: 1},
                limit: {type: 'int', min: 1, max: 100, default: 100},
                sort: {type: 'string', values: ['created'], default: 'created'},
                order: {type: 'string', values: ['asc', 'desc'], default: 'desc'},

                collection_name: {type: 'string', min: 1, max: 12},
                schema_name: {type: 'string', min: 1, max: 12},
                authorized_account: {type: 'string', min: 1, max: 12},
            });

            if (typeof req.params.collection_name === 'string' && req.params.collection_name.length > 0) {
                args.collection_name = req.params.collection_name;
            }

            let varCounter = 1;
            let queryString = 'SELECT * FROM atomicassets_templates_master template WHERE contract = $1 ';
            let queryValues: any[] = [core.args.contract];

            if (args.collection_name) {
                const data = buildDataConditions(req.query, varCounter);

                if (data.conditions.length > 0) {
                    queryString += 'AND EXISTS (' +
                            'SELECT "key" ' +
                            'FROM atomicassets_templates_data data ' +
                            'WHERE data.contract = template.contract AND data.template_id = template.template_id AND ' +
                            '(' + data.conditions.join(' OR ') + ')' +
                        ') ';

                    queryValues = queryValues.concat(data.values);
                    varCounter += data.values.length;
                }
            }

            if (args.collection_name) {
                queryString += 'AND collection_name = $' + ++varCounter + ' ';
                queryValues.push(args.collection_name);
            }

            if (args.schema_name) {
                queryString += 'AND schema_name = $' + ++varCounter + ' ';
                queryValues.push(args.schema_name);
            }

            if (args.authorized_account) {
                queryString += 'AND $' + ++varCounter + ' = ANY(authorized_accounts) ';
                queryValues.push(args.authorized_account);
            }

            const sortColumnMapping = {
                created: 'created_at_block'
            };

            // @ts-ignore
            queryString += 'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ' ';
            queryString += 'LIMIT $' + ++varCounter + ' OFFSET $' + ++varCounter + ' ';
            queryValues.push(args.limit);
            queryValues.push((args.page - 1) * args.limit);

            logger.debug(queryString);

            const query = await core.connection.database.query(queryString, queryValues);

            return res.json({success: true, data: query.rows.map((row) => formatTemplate(row))});
        } catch (e) {
            logger.error(e);

            res.status(500);
            res.json({success: false, message: 'Internal Server Error'});
        }
    }

    router.get('/v1/templates', templateRequestHandler);
    router.get('/v1/templates/:collection_name', templateRequestHandler);

    router.get('/v1/templates/:collection_name/:template_id', (async (req, res) => {
        try {
            const query = await core.connection.database.query(
                'SELECT * FROM atomicassets_templates_master WHERE contract = $1 AND collection_name = $2 AND template_id = $3',
                [core.args.contract, req.params.collection_name, req.params.template_id]
            );

            if (query.rowCount === 0) {
                res.status(500);
                return res.json({success: false, message: 'Template not found'});
            }

            return res.json({success: true, data: formatTemplate(query.rows[0])});
        } catch (e) {
            logger.error(e);

            res.status(500);
            res.json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/templates/:collection_name/:template_id/logs', (async (req, res) => {
        const args = filterQueryArgs(req, {
            page: {type: 'int', min: 1, default: 1},
            limit: {type: 'int', min: 1, max: 100, default: 100}
        });

        try {
            res.json({
                success: true,
                data: await getLogs(
                    core.connection.database, core.args.contract, 'template',
                    req.params.collection_name + ':' + req.params.template_id,
                    (args.page - 1) * args.limit, args.limit
                )
            });
        } catch (e) {
            logger.error(e);

            res.status(500);
            return res.json({success: false, message: 'Internal Server Error'});
        }
    }));

    return {
        tag: {
            name: 'templates',
            description: 'Templates'
        },
        paths: {
            '/v1/templates': {
                get: {
                    tags: ['templates'],
                    summary: 'Fetch templates',
                    produces: ['application/json'],
                    parameters: [
                        {
                            name: 'collection_name',
                            in: 'query',
                            description: 'Get all templates within the collection',
                            required: false,
                            type: 'string'
                        },
                        {
                            name: 'schema_name',
                            in: 'query',
                            description: 'Get all templates which implement that schema',
                            required: false,
                            type: 'string'
                        },
                        {
                            name: 'authorized_account',
                            in: 'query',
                            description: 'Filter for templates the provided account can use',
                            required: false,
                            type: 'string'
                        },
                        ...standardArrayFilter,
                        {
                            name: 'sort',
                            in: 'query',
                            description: 'Column to sort',
                            required: false,
                            type: 'string',
                            enum: ['created'],
                            default: 'created'
                        }
                    ],
                    responses: {
                        '200': {
                            description: 'OK',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: true},
                                    data: {type: 'array', items: {'$ref': '#/definitions/Template'}}
                                }
                            }
                        },
                        '500': {
                            description: 'Internal Server Error',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: false},
                                    message: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            },
            '/v1/templates/{collection_name}/{template_id}': {
                get: {
                    tags: ['templates'],
                    summary: 'Find template by id',
                    produces: ['application/json'],
                    parameters: [
                        {
                            name: 'collection_name',
                            in: 'path',
                            description: 'Name of collection',
                            required: true,
                            type: 'string'
                        },
                        {
                            name: 'template_id',
                            in: 'path',
                            description: 'ID of template',
                            required: true,
                            type: 'integer'
                        }
                    ],
                    responses: {
                        '200': {
                            description: 'OK',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: true},
                                    data: {'$ref': '#/definitions/Template'}
                                }
                            }
                        },
                        '500': {
                            description: 'Internal Server Error',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: false},
                                    message: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            },
            '/v1/templates/{collection_name}/{template_id}/logs': {
                get: {
                    tags: ['templates'],
                    summary: 'Fetch template logs',
                    produces: ['application/json'],
                    parameters: [
                        {
                            name: 'collection_name',
                            in: 'path',
                            description: 'Name of collection',
                            required: true,
                            type: 'string'
                        },
                        {
                            name: 'template_id',
                            in: 'path',
                            description: 'ID of template',
                            required: true,
                            type: 'integer'
                        }
                    ],
                    responses: {
                        '200': {
                            description: 'OK',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: true},
                                    data: {'$ref': '#/definitions/Log'}
                                }
                            }
                        },
                        '500': {
                            description: 'Internal Server Error',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: false},
                                    message: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            }
        },
        definitions: {}
    };
}