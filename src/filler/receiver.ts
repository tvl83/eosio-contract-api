import { Serialize } from 'eosjs';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';

import logger from '../utils/winston';
import ConnectionManager from '../connections/manager';
import StateHistoryBlockReader from '../connections/ship';
import { IReaderConfig } from '../types/config';
import { ShipActionTrace, ShipBlock, ShipContractRow, ShipHeader, ShipTableDelta, ShipTransactionTrace } from '../types/ship';
import { EosioAction, EosioTableRow } from '../types/eosio';
import { ContractDB, ContractDBTransaction } from './database';
import { IContractHandler } from './handlers';
import { binToHex } from '../utils/binary';
import { eosioTimestampToDate } from '../utils/time';
import { serializeEosioName } from '../utils/eosio';

type AbiCache = {
    types: Map<string, Serialize.Type>,
    block_num: number,
    json: Abi
};

export default class StateReceiver {
    currentBlock = 0;
    headBlock = 0;
    lastIrreversibleBlock = 0;

    private readonly ship: StateHistoryBlockReader;
    private readonly database: ContractDB;

    private readonly abis: {[key: string]: AbiCache};

    constructor(
        private readonly config: IReaderConfig,
        private readonly connection: ConnectionManager,
        private readonly handlers: IContractHandler[]
    ) {
        this.ship = connection.createShipBlockReader({
            min_block_confirmation: config.ship_min_block_confirmation
        });

        this.database = new ContractDB(this.config.name, this.connection);
        this.abis = {};

        this.ship.consume(this.consumer.bind(this));
    }

    async startProcessing(): Promise<void> {
        let startBlock = await this.database.getReaderPosition() + 1;

        if (this.config.start_block > 0 && this.config.start_block < startBlock) {
            throw new Error('Reader start block cannot be lower than the last processed block');
        }

        startBlock = Math.max(startBlock, this.config.start_block);

        logger.info('Reader ' + this.config.name + ' starting on block #' + startBlock);

        this.ship.startProcessing({
            start_block_num: startBlock,
            max_messages_in_flight: this.config.ship_prefetch_blocks || 10,
            fetch_block: true,
            fetch_traces: true,
            fetch_deltas: true
        });
    }

    private async consumer(
        header: ShipHeader,
        block: ShipBlock,
        traces: ShipTransactionTrace[],
        deltas: ShipTableDelta[]
    ): Promise<void> {
        let processDeltas = this.config.start_from_snapshot && this.currentBlock === 0;

        const db = await this.database.startTransaction(header.this_block.block_num, header.last_irreversible.block_num);

        if (header.this_block.block_num <= this.currentBlock) {
            await db.rollbackReversibleBlocks(header.this_block.block_num);
        }

        for (const transactionTrace of traces) {
            processDeltas = await this.handleTransactionTrace(db, block, transactionTrace) || processDeltas;
        }

        if (processDeltas) {
            for (const delta of deltas) {
                await this.handleDelta(db, block, delta);
            }

            await db.updateReaderPosition(block);
            await db.clearForkDatabase();
        } else if (header.this_block.block_num >= header.last_irreversible.block_num) {
            // always update reader position when in live reader mode
            await db.updateReaderPosition(block);
        } else if (header.this_block.block_num % 100 === 0) {
            await db.updateReaderPosition(block);
        }

        this.currentBlock = header.this_block.block_num;
        this.headBlock = header.head.block_num;
        this.lastIrreversibleBlock = header.last_irreversible.block_num;

        await db.commit();
    }

    private async handleTransactionTrace(
        db: ContractDBTransaction, block: ShipBlock, transactionTrace: ShipTransactionTrace
    ): Promise<boolean> {
        if (transactionTrace[0] === 'transaction_trace_v0') {
            if (transactionTrace[1].error_code) {
                logger.warn('Failed transaction ' + transactionTrace[1].id + ' received from ship');

                return false;
            }

            let processDeltas = false;

            for (const actionTrace of transactionTrace[1].action_traces) {
                processDeltas = await this.handleActionTrace(db, block, actionTrace) || processDeltas;
            }

            return processDeltas;
        }

        await db.abort();

        throw new Error('unsupported transaction response received: ' + transactionTrace[0]);
    }

    private async handleActionTrace(
        db: ContractDBTransaction, block: ShipBlock, actionTrace: ShipActionTrace
    ): Promise<boolean> {
        if (actionTrace[0] === 'action_trace_v0') {
            // ignore if its a notification
            if (actionTrace[1].receiver !== actionTrace[1].act.account) {
                return this.isContractInScope(actionTrace[1].act.account);
            }

            if (this.isActionInScope(actionTrace[1].act.account, actionTrace[1].act.name)) {
                const types = await this.fetchContractTypes(actionTrace[1].act.account, block.block_num);
                const type = await this.getActionType(actionTrace[1].act.account, actionTrace[1].act.name, block.block_num);

                let data;

                // save hex data if ABI does not exist for contract
                if (types === null || type === null) {
                    data = binToHex(actionTrace[1].act.data);
                } else {
                    try {
                        data = this.ship.deserialize(type, actionTrace[1].act.data, types);
                    } catch (e) {
                        logger.error(e);

                        data = binToHex(actionTrace[1].act.data);
                    }
                }

                await this.handleAction(db, block, {
                    account: actionTrace[1].act.account,
                    name: actionTrace[1].act.name,
                    authorization: actionTrace[1].act.authorization,
                    data
                });
            }

            return this.isContractInScope(actionTrace[1].act.account);
        }

        await db.abort();

        throw new Error('Unsupported trace response received: ' + actionTrace[0]);
    }

    private async handleAction(db: ContractDBTransaction, block: ShipBlock, action: EosioAction): Promise<void> {
        if (action.account === 'eosio') {
            if (action.name === 'setcode') {
                await this.handleCodeUpdate(db, block, action);
            } else if (action.name === 'setabi') {
                await this.handleAbiUpdate(db, block, action);
            }
        }

        const handlers = this.getActionHandlers(action.account, action.name);

        for (const handler of handlers) {
            await handler.onAction(db, block, action);
        }
    }

    private async handleDelta(db: ContractDBTransaction, block: ShipBlock, delta: ShipTableDelta): Promise<void> {
        if (delta[0] === 'table_delta_v0') {
            const whitelist = ['contract_row'];

            if (whitelist.indexOf(delta[1].name) >= 0) {
                const rows = delta[1].rows.map((row) => {
                    return {
                        present: row.present,
                        data: this.ship.deserialize(delta[1].name, row.data, this.ship.types)
                    };
                });

                if (delta[1].name === 'contract_row') {
                    for (const row of rows) {
                        await this.handleContractRow(db, block, row.data, row.present);
                    }
                }
            }

            return;
        }

        await db.abort();

        throw new Error('Unsupported table delta response received: ' + delta[0]);
    }

    private async handleContractRow(
        db: ContractDBTransaction, block: ShipBlock, contractRow: ShipContractRow, present: boolean
    ): Promise<void> {
        if (contractRow[0] === 'contract_row_v0') {
            if (!this.isContractInScope(contractRow[1].code)) {
                return;
            }

            const types = await this.fetchContractTypes(contractRow[1].code, block.block_num);
            const type = await this.getTableType(contractRow[1].code, contractRow[1].table, block.block_num);

            let data;

            if (type === null || types === null) {
                data = binToHex(contractRow[1].value);
            } else {
                try {
                    data = this.ship.deserialize(type, contractRow[1].value, types);
                } catch (e) {
                    logger.warn(e);

                    data = binToHex(contractRow[1].value);
                }
            }

            const tableDelta = { ...contractRow[1], present, value: data };

            await this.handleTableDelta(db, block, tableDelta);

            return;
        }

        await db.abort();

        throw new Error('Unsupported contract row response received: ' + contractRow[0]);
    }

    private async handleTableDelta(db: ContractDBTransaction, block: ShipBlock, row: EosioTableRow): Promise<void> {
        const handlers = this.getActionHandlers(row.code);

        for (const handler of handlers) {
            await handler.onTableChange(db, block, row);
        }
    }

    private async handleAbiUpdate(db: ContractDBTransaction, block: ShipBlock, action: EosioAction): Promise<void> {
        if (typeof action.data !== 'string') {
            const abiJson = this.connection.chain.deserializeAbi(action.data.abi);
            const types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abiJson);

            this.abis[action.data.account] = { json: abiJson, types, block_num: block.block_num };

            const query = await db.client.query(
                'SELECT account FROM contract_abis WHERE account = $1 AND block_num = $2',
                [serializeEosioName(action.data.account), block.block_num]
            );

            if (query.rows.length > 0) {
                await db.insert('contract_abis', {
                    account: serializeEosioName(action.data.account),
                    abi: action.data.abi,
                    block_num: block.block_num,
                    block_time: eosioTimestampToDate(block.timestamp).getTime()
                }, ['account', 'block_num']);
            } else {
                logger.info('ABI ' + action.data.account + ' already in cache. Ignoring ABI update');
            }

            logger.info('ABI updated for contract ' + action.data.account);
        } else {
            logger.error('Could not update ABI for contract because action could not be deserialized');
        }
    }

    private async handleCodeUpdate(db: ContractDBTransaction, block: ShipBlock, action: EosioAction): Promise<void> {
        if (typeof action.data !== 'string') {
            const query = await db.client.query(
                'SELECT account FROM contract_codes WHERE account = $1 AND block_num = $2',
                [serializeEosioName(action.data.account), block.block_num]
            );

            if (query.rows.length > 0) {
                await db.insert('contract_codes', {
                    account: serializeEosioName(action.data.account),
                    block_num: block.block_num,
                    block_time: eosioTimestampToDate(block.timestamp).getTime()
                }, ['account', 'block_num']);
            } else {
                logger.info('Code ' + action.data.account + ' already in cache. Ignoring code update');
            }

            logger.info('Code updated for contract ' + action.data.account);
        } else {
            logger.error('Could not update contract code because action could not be deserialized');
        }
    }

    private async fetchContractAbi(contract: string, blockNum: number): Promise<AbiCache> {
        if (this.abis[contract] && this.abis[contract].block_num <= blockNum) {
            return this.abis[contract];
        }

        let abiJson: Abi, abiBlock: number;

        let rawAbi = await this.database.fetchAbi(contract, blockNum);

        if (rawAbi) {
            abiJson = this.connection.chain.deserializeAbi(rawAbi.data);
            abiBlock = rawAbi.block_num;
        } else {
            logger.warn('Could not find ABI for ' + contract + ' in cache, so requesting it...');

            rawAbi = await this.database.fetchNextAbi(contract, blockNum);

            if (rawAbi) {
                abiJson = this.connection.chain.deserializeAbi(rawAbi.data);
                abiBlock = rawAbi.block_num;
            } else {
                abiJson = (await this.connection.chain.rpc.get_abi(contract)).abi;
                abiBlock = blockNum;
            }
        }

        const cache = {
            json: abiJson ? abiJson : null,
            types: abiJson ? Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abiJson) : null,
            block_num: abiBlock
        };

        if (cache.types === null) {
            logger.warn('ABI for contract ' + contract + ' not found');
        }

        if (!this.abis[contract] || this.abis[contract].block_num <= abiBlock) {
            this.abis[contract] = cache;
        }

        return cache;
    }

    private async fetchContractTypes(contract: string, blockNum: number): Promise<Map<string, Serialize.Type>> {
        const cache = await this.fetchContractAbi(contract, blockNum);

        return cache.types;
    }

    private async getTableType(contract: string, table: string, blockNum: number): Promise<string | null> {
        const cache = await this.fetchContractAbi(contract, blockNum);

        if (!cache.json) {
            return null;
        }

        for (const row of cache.json.tables) {
            if (row.name === table) {
                return row.type;
            }
        }

        return null;
    }

    private async getActionType(contract: string, action: string, blockNum: number): Promise<string | null> {
        const cache = await this.fetchContractAbi(contract, blockNum);

        if (!cache.json) {
            return null;
        }

        for (const row of cache.json.actions) {
            if (row.name === action) {
                return row.type;
            }
        }

        return null;
    }

    private isActionInScope(contract: string, action: string): boolean {
        const blacklist = ['eosio.null:*', 'eosio:onblock', 'eosio:onerror'];
        let whitelist = ['eosio:setcode', 'eosio:setabi'];

        for (const config of this.config.contracts) {
            whitelist = whitelist.concat(config.scope);
        }

        for (const scope of blacklist) {
            if (!StateReceiver.matchActionScope(scope, contract, action)) {
                continue;
            }

            return false;
        }

        for (const scope of whitelist) {
            if (!StateReceiver.matchActionScope(scope, contract, action)) {
                continue;
            }

            return true;
        }

        return false;
    }

    private isContractInScope(contract: string): boolean {
        for (const config of this.config.contracts) {
            for (const scope of config.scope) {
                if (!StateReceiver.matchActionScope(scope, contract)) {
                    continue;
                }

                return true;
            }
        }

        return false;
    }

    private getActionHandlers(contract: string, action?: string): IContractHandler[] {
        const handlers = [];

        for (let i = 0; i < this.config.contracts.length; i++) {
            for (const scope of this.config.contracts[i].scope) {
                if (!StateReceiver.matchActionScope(scope, contract, action)) {
                    continue;
                }

                handlers.push(this.handlers[i]);

                break;
            }
        }

        return handlers;
    }

    private static matchActionScope(scope: string, contract: string, action?: string): boolean {
        const split = scope.split(':');

        if (split[0] === contract || split[0] === '*') {
            if (split[1] === '*' || !action) {
                return true;
            }

            if (split[1] === action) {
                return true;
            }
        }

        return false;
    }
}