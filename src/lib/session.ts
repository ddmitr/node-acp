
import Message, {HEADER_SIZE as MESSAGE_HEADER_SIZE} from './message';
import {HEADER_SIZE as ELEMENT_HEADER_SIZE} from './property';
// import {ClientEncryption, ServerEncryption} from './encryption';
import {LogLevel, loglevel, CFLBinaryPList} from '..';

import adler32 from 'adler32';

import net from 'net';
import crypto from 'crypto';
import EventEmitter from 'events';

export default class Session extends EventEmitter {
    readonly host: string;
    readonly port: number;
    readonly password: string;

    socket: net.Socket | null = null;
    buffer = Buffer.alloc(0);
    reading = 0;

    encryption: ClientEncryption | ServerEncryption | null = null;

    /**
     * Creates a Session.
     *
     * @param {string} host
     * @param {number} port
     * @param {string} password
     */
    constructor(host: string, port: number, password: string) {
        super();

        this.host = host;
        this.port = port;
        this.password = password;
    }

    /**
     * Connects to the ACP server.
     *
     * @param {number} timeout
     * @return {Promise}
     */
    connect(timeout = 10000) {
        return new Promise<void>((resolve, reject) => {
            this.socket = new net.Socket();

            setTimeout(() => {
                // this.reading -= 1;
                reject('Timeout');
            }, timeout);

            // @ts-ignore
            this.socket.connect(this.port, this.host, (err: any) => {
                if (loglevel >= LogLevel.INFO) console.log('Connected', err);
                this.emit('connected');
                if (err) reject(err);
                else resolve();
            });

            this.socket.on('close', had_error => {
                this.socket = null;
                this.encryption = null;
                this.emit('disconnected');

                for (const reject of this._queue_rejects) reject();
            });

            this.socket.on('data', data => {
                if (loglevel >= LogLevel.DEBUG) console.debug(0, 'Receiving data', data);

                this.emit('raw-data', data);

                if (this.encryption) {
                    data = this.encryption.decrypt(data);
                    if (loglevel >= LogLevel.DEBUG) console.debug(0, 'Decrypted', data);
                }

                this.buffer = Buffer.concat([this.buffer, data]);

                this.emit('data', data);

                if (!this.reading) this._handleData(data);
            });
        });
    }

    /**
     * Handles unsolicited data.
     *
     * @param {Buffer} data
     */
    private async _handleData(data: Buffer) {
        while (!this.reading && this.buffer.length) {
            try {
                await this.handleData(this.buffer);
            } catch (err) {
                console.error('Error handling data', err);
            }
        }
    }

    async handleData(data: Buffer) {
        // 58 45 00 95 00 00 00 6f + CFL binary plist
        // 58 45 00 95 is header magic?
        //             00 00 00 6f is the CFL binary plist length
        // 58 45 00 45 00 00 00 72 + CFL binary plist
        // 58 45 00 45 is header magic?
        //             00 00 00 72 is the CFL binary plist length

        if (data.slice(0, 2).toString('binary') === 'XE') return this.handleMonitorData();

        console.warn('Unknown data received', data);
        this.buffer = Buffer.alloc(0);
    }

    async handleMonitorData() {
        const header = await this.receive(8);
        const magic = header.slice(0, 4).toString('binary');
        const size = header.readUInt32BE(4);
        const body = await this.receive(size);

        try {
            const data = CFLBinaryPList.parse(body);

            this.emit('monitor-data', data);
        } catch (err) {
            console.error('Error parsing monitor data', err);
        }
    }

    /**
     * Disconnects from the ACP server.
     *
     * @return {Promise}
     */
    close() {
        if (!this.socket) return;

        this.socket.end();

        return new Promise<void>((resolve, reject) => {
            this.socket!.on('close', () => {
                this.socket = null;
                this.emit('disconnected');
                resolve();
            });
        });
    }

    /**
     * Receives and parses a Message from the ACP server.
     *
     * @param {number} timeout
     * @return {Promise<Message>}
     */
    async receiveMessage(timeout?: number) {
        const raw_header = await this.receiveMessageHeader(timeout);
        const {body_checksum} = Message.unpackHeader(raw_header);
        const message = await Message.parseRaw(raw_header);

        const data = await this.receive(message.body_size, timeout);

        if (data && body_checksum !== adler32.sum(data)) {
            throw new Error('Body checksum does not match');
        }

        // @ts-ignore
        message.body = data;

        return message;
    }

    /**
     * Receives a message header from the ACP server.
     *
     * @param {number} timeout
     * @return {Promise<Buffer>}
     */
    receiveMessageHeader(timeout?: number) {
        return this.receive(MESSAGE_HEADER_SIZE, timeout);
    }

    /**
     * Receives a property element header from the ACP server.
     *
     * @param {number} timeout
     * @return {Promise<Buffer>}
     */
    receivePropertyElementHeader(timeout?: number) {
        return this.receive(ELEMENT_HEADER_SIZE, timeout);
    }

    /**
     * Sends and receives data to/from the ACP server.
     *
     * @param {Message|Buffer|string} data
     * @param {number} size
     * @param {number} timeout
     * @return {Promise<Buffer>}
     */
    async sendAndReceive(data: Message | Buffer | string, size: number, timeout?: number) {
        await this.send(data);

        return await this.receive(size, timeout);
    }

    /**
     * Sends data to the ACP server.
     *
     * @param {Message|Buffer|string} data
     * @return {Promise<Buffer>}
     */
    send(data: Message | Buffer | string) {
        if (data instanceof Message) {
            data = data.composeRawPacket();
        }

        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data, 'binary');
        }

        if (this.encryption) {
            if (loglevel >= LogLevel.DEBUG) console.debug(0, 'Before encryption', data);
            data = this.encryption.encrypt(data);
        }

        if (!this.socket) {
            throw new Error('Not connected');
        }

        return new Promise<void>((resolve, reject) => {
            if (loglevel >= LogLevel.DEBUG) console.info(0, 'Sending data', data);
            this.socket!.write(data as Buffer, 'binary', err => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Receives raw data from the ACP server.
     *
     * @param {number} size
     * @param {number} timeout (default is 10000 ms / 10 seconds)
     * @return {Promise<Buffer>}
     */
    private async receiveSize(size: number, timeout = 10000) {
        this.reading++;

        try {
            const received_chunks = [this.buffer.slice(0, size)];
            this.buffer = this.buffer.slice(size);
            let waiting_for = size - received_chunks[0].length;

            let last_received_at = Date.now();

            while (waiting_for > 0) {
                if (last_received_at > Date.now() + timeout) {
                    throw new Error('Timeout');
                }

                await new Promise(r => setTimeout(r, 1));

                if (this.buffer) {
                    const received = this.buffer.slice(0, waiting_for);
                    waiting_for = waiting_for - received.length;
                    received_chunks.push(received);
                    this.buffer = this.buffer.slice(received.length);
                    last_received_at = Date.now();
                }
            }

            return Buffer.concat(received_chunks);
        } finally {
            this.reading -= 1;
        }
    }

    /**
     * Receives and decrypts data from the ACP server.
     *
     * @param {number} size
     * @param {number} timeout
     * @return {Promise<string>}
     */
    async receive(size: number, timeout?: number) {
        let data = await this.receiveSize(size, timeout);

        return data;
    }

    private _queue = Promise.resolve();
    private _queue_rejects: ((reason?: any) => void)[] = [];

    /**
     * Adds a function to the session queue.
     *
     * @param {function} callback Function to call
     * @return {Promise}
     */
    queue<T>(callback: (session: SessionLock) => PromiseLike<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this._queue_rejects.push(reject);

            this._queue = this._queue.then(async () => {
                const index = this._queue_rejects.indexOf(reject);
                if (index <= -1) return reject(new Error('Canceled'));
                this._queue_rejects.splice(index, 1);

                const session = new SessionLock(this);

                try {
                    resolve(await callback(session));
                } catch (err) {
                    reject(err);
                }

                session.invalidate();
            });
        });
    }

    enableEncryption(key: Buffer, client_iv: Buffer, server_iv: Buffer) {
        this.encryption = new ClientEncryption(key, client_iv, server_iv);
    }

    enableServerEncryption(key: Buffer, client_iv: Buffer, server_iv: Buffer) {
        this.encryption = new ServerEncryption(key, client_iv, server_iv);
    }
}

export class SessionLock {
    constructor(private session: Session | null) {}

    invalidate() {
        this.session = null;
    }

    get encrypted() {
        if (!this.session) throw new Error('Lock is no longer valid');

        return this.session.encryption;
    }

    get local_address(): [string, number] {
        if (!this.session) throw new Error('Lock is no longer valid');

        return [this.session.socket!.localAddress, this.session.socket!.localPort];
    }

    get remote_address(): [string, number] {
        if (!this.session) throw new Error('Lock is no longer valid');

        return [this.session.socket!.remoteAddress!, this.session.socket!.remotePort!];
    }

    /**
     * Sends data to the ACP server.
     *
     * @param {Message|Buffer|string} data
     * @return {Promise}
     */
    send(data: Message | Buffer | string) {
        if (!this.session) throw new Error('Lock is no longer valid');

        return this.session.send(data);
    }

    /**
     * Receives and decrypts data from the ACP server.
     *
     * @param {number} size
     * @param {number} [timeout]
     * @return {Promise<Buffer>}
     */
    receive(size: number, timeout?: number) {
        if (!this.session) throw new Error('Lock is no longer valid');

        return this.session.receive(size, timeout);
    }

    /**
     * Receives a message header from the ACP server.
     *
     * @param {number} [timeout]
     * @return {Promise<Buffer>}
     */
    receiveMessageHeader(timeout?: number) {
        return this.receive(MESSAGE_HEADER_SIZE, timeout);
    }

    /**
     * Receives a property element header from the ACP server.
     *
     * @param {number} [timeout]
     * @return {Promise<Buffer>}
     */
    receivePropertyElementHeader(timeout?: number) {
        return this.receive(ELEMENT_HEADER_SIZE, timeout);
    }

    /**
     * Receives and parses a Message from the ACP server.
     *
     * @param {number} [timeout]
     * @return {Promise<Message>}
     */
    async receiveMessage(timeout?: number) {
        if (!this.session) throw new Error('Lock is no longer valid');

        return this.session.receiveMessage(timeout);
    }
}

interface EncryptionContext {
    cipher: crypto.Cipher;
    decipher: crypto.Decipher;
}

class Encryption {
    readonly key: Buffer;
    readonly client_iv: Buffer;
    readonly server_iv: Buffer;

    readonly derived_client_key: Buffer;
    readonly derived_server_key: Buffer;

    readonly client_context: EncryptionContext;
    readonly server_context: EncryptionContext;

    constructor(key: Buffer, client_iv: Buffer, server_iv: Buffer) {
        this.key = key;
        this.client_iv = client_iv;
        this.server_iv = server_iv;

        const derived_client_key = this.derived_client_key =
            crypto.pbkdf2Sync(key, PBKDF_salt0, 5, 16, 'sha1'); // KDF.PBKDF2(key, PBKDF_salt0, 16, 5)
        const derived_server_key = this.derived_server_key =
            crypto.pbkdf2Sync(key, PBKDF_salt1, 7, 16, 'sha1'); // KDF.PBKDF2(key, PBKDF_salt1, 16, 7);
        //                                                         PBKDF2(password, salt, dkLen=16, count=1000, prf=None)

        this.client_context = this.constructor.createEncryptionContext(derived_client_key, client_iv);
        this.server_context = this.constructor.createEncryptionContext(derived_server_key, server_iv);
    }

    static createEncryptionContext(key: Buffer, iv: Buffer) {
        return {
            cipher: crypto.createCipheriv('aes-128-ctr', key, iv),
            decipher: crypto.createDecipheriv('aes-128-ctr', key, iv),
        };
    }

    clientEncrypt(data: Buffer) {
        return this.client_context.cipher.update(data);
    }

    clientDecrypt(data: Buffer) {
        return this.client_context.decipher.update(data);
    }

    serverEncrypt(data: Buffer) {
        return this.server_context.cipher.update(data);
    }

    serverDecrypt(data: Buffer) {
        return this.server_context.decipher.update(data);
    }
}

interface Encryption {
    constructor: typeof Encryption;
}

export {Encryption};

const PBKDF_salt0 = Buffer.from('F072FA3F66B410A135FAE8E6D1D43D5F', 'hex');
const PBKDF_salt1 = Buffer.from('BD0682C9FE79325BC73655F4174B996C', 'hex');

export class ClientEncryption extends Encryption {
    encrypt(data: Buffer) {
        return this.clientEncrypt(data);
    }

    decrypt(data: Buffer) {
        return this.serverDecrypt(data);
    }
}

export class ServerEncryption extends Encryption {
    encrypt(data: Buffer) {
        return this.serverEncrypt(data);
    }

    decrypt(data: Buffer) {
        return this.clientDecrypt(data);
    }
}
