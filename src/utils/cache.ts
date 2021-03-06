import * as express from 'express';
import * as NodeRedis from 'redis';
import * as crypto from 'crypto';

import logger from './winston';
import { mergeRequestData } from '../api/namespaces/utils';

export type ExpressRedisCacheOptions = {
    expire?: number,
    ignoreQueryString?: boolean,
    urlHandler?: express.RequestHandler
};

export type ExpressRedisCacheHandler = (options?: ExpressRedisCacheOptions) => express.RequestHandler;

export function expressRedisCache(
    redis: NodeRedis.RedisClient, prefix: string, expire: number, whitelistedIPs?: string[]
): ExpressRedisCacheHandler {
    return (options: ExpressRedisCacheOptions = {}) => {
        return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
            const cacheLife = options.expire ? options.expire : expire;

            if (cacheLife === 0) {
                return next();
            }

            if (whitelistedIPs && whitelistedIPs.indexOf(req.ip) >= 0) {
                return next();
            }

            let key: string;
            if (options.urlHandler) {
                key = prefix + ':' + String(options.urlHandler(req, res, next));
            } else if (options.ignoreQueryString) {
                key = prefix + ':' + req.baseUrl + req.path;
            } else {
                const hash = crypto.createHash('sha256');

                if (req.body) {
                    hash.update(JSON.stringify(req.body));
                }

                if (req.query) {
                    hash.update(JSON.stringify(req.query));
                }

                key = prefix + ':' + req.baseUrl + req.path + ':' + hash.digest().toString('hex');
            }

            redis.get(key, (_, reply) => {
                if (reply === null) {
                    const sendFn = res.send.bind(res);

                    res.send = (data: Buffer | string): express.Response => {
                        sendFn(data);

                        let content;
                        if (typeof data === 'string') {
                            content = Buffer.from(data, 'utf8').toString('base64');
                        } else {
                            content = data.toString('base64');
                        }

                        redis.set(key, res.getHeader('content-type') + '::' + res.statusCode + '::' + content, () => {
                            redis.expire(key, Math.round(cacheLife));

                            logger.debug('Cache request ' + key + ' for ' + cacheLife + ' seconds', mergeRequestData(req));
                        });

                        return res;
                    };

                    next();
                } else {
                    logger.debug('Request was cached - returning cached version for ' + key, mergeRequestData(req));

                    const split = reply.split('::');

                    if (split[0]) {
                        res.contentType(split[0]);
                    }

                    if (split[1]) {
                        res.status(parseInt(split[1], 10));
                    }

                    const buffer = Buffer.from(split[2], 'base64');

                    res.send(buffer);
                }
            });
        };
    };
}
