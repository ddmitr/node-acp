
import Message, {HEADER_SIZE as MESSAGE_HEADER_SIZE} from './message';
import {HEADER_SIZE as ELEMENT_HEADER_SIZE} from './property';
// import {ClientEncryption, ServerEncryption} from './encryption';

import net from 'net';
import crypto from 'crypto';
import EventEmitter from 'events';

export default class Session extends EventEmitter {
    /**
     * Creates a Session.
     *
     * @param {string} host
     * @param {number} port
     * @param {string} password
     * @return {undefined}
     */
    constructor(host, port, password) {
        super();

        this.host = host;
        this.port = port;
        this.password = password;

        this.socket = undefined;
        this.buffer = '';
        this.reading = 0;

        this.encryption = undefined;
    }

    /**
     * Connects to the ACP server.
     *
     * @param {number} timeout
     * @return {Promise}
     */
    connect(timeout = 10000) {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();

            setTimeout(() => {
                this.reading -= 1;
                reject('Timeout');
            }, timeout);

            this.socket.connect(this.port, this.host, err => {
                console.log('Connected', err);
                this.emit('connected');
                if (err) reject(err);
                else resolve();
            });

            this.socket.on('close', had_error => {
                this.socket = undefined;
                this.emit('disconnected');
            });

            this.socket.on('data', data => {
                console.debug(0, 'Receiving data', data);

                this.emit('raw-data', data);

                if (this.encryption) {
                    data = this.encryption.decrypt(data);
                    console.debug(0, 'Decrypted', data);
                }

                this.buffer += data.toString('binary');

                this.emit('data', data);
            });
        });
    }

    /**
     * Disconnects from the ACP server.
     *
     * @return {Promise}
     */
    close() {
        if (!this.socket) return;

        this.socket.end();

        return new Promise((resolve, reject) => {
            this.socket.on('close', () => {
                this.socket = undefined;
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
    async receiveMessage(timeout) {
        const raw_header = await this.receiveMessageHeader(timeout);
        const message = await Message.parseRaw(raw_header);

        const data = await this.receive(message.body_size);

        message.body = data;

        return message;
    }

    /**
     * Receives a message header from the ACP server.
     *
     * @param {number} timeout
     * @return {Promise<string>}
     */
    receiveMessageHeader(timeout) {
        return this.receive(MESSAGE_HEADER_SIZE, timeout);
    }

    /**
     * Receives a property element header from the ACP server.
     *
     * @param {number} timeout
     * @return {Promise<string>}
     */
    receivePropertyElementHeader(timeout) {
        return this.receive(ELEMENT_HEADER_SIZE, timeout);
    }

    /**
     * Sends and receives data to/from the ACP server.
     *
     * @param {Message|Buffer|string} data
     * @param {number} size
     * @param {number} timeout
     * @return {Promise<string>}
     */
    async sendAndReceive(data, size, timeout = 10000) {
        await this.send(data);

        return await this.receive(size, timeout);
    }

    /**
     * Sends data to the ACP server.
     *
     * @param {Message|Buffer|string} data
     * @return {Promise}
     */
    send(data) {
        if (data instanceof Message) {
            data = data.composeRawPacket();
        }

        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data, 'binary');
        }

        if (this.encryption) {
            console.debug(0, 'Before encryption', data);
            data = this.encryption.encrypt(data);
        }

        if (!this.socket) return;

        return new Promise((resolve, reject) => {
            console.info(0, 'Sending data', data);
            this.socket.write(data, 'binary', err => {
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
     * @return {Promise<string>}
     */
    async receiveSize(size, timeout = 10000) {
        this.reading++;

        try {
            const received_chunks = [this.buffer.substr(0, size)];
            this.buffer = this.buffer.substr(size);
            let waiting_for = size - received_chunks[0].length;

            let last_received_at = Date.now();

            while (waiting_for > 0) {
                if (last_received_at > Date.now() + timeout) {
                    throw new Error('Timeout');
                }

                await new Promise(r => setTimeout(r, 1));

                if (this.buffer) {
                    const received = this.buffer.substr(0, waiting_for);
                    waiting_for = waiting_for - received.length;
                    received_chunks.push(received);
                    this.buffer = this.buffer.substr(received.length);
                    last_received_at = Date.now();
                }
            }

            return received_chunks.join('');
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
    async receive(size, timeout = 10000) {
        let data = await this.receiveSize(size, timeout);

        return data;
    }

    enableEncryption(key, client_iv, server_iv) {
        this.encryption = new ClientEncryption(key, client_iv, server_iv);
    }

    enableServerEncryption(key, client_iv, server_iv) {
        this.encryption = new ServerEncryption(key, client_iv, server_iv);
    }
}

export class Encryption {
    constructor(key, client_iv, server_iv) {
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

    static createEncryptionContext(key, iv) {
        return {
            cipher: crypto.createCipheriv('aes-128-ctr', key, iv),
            decipher: crypto.createDecipheriv('aes-128-ctr', key, iv),
        };
    }

    clientEncrypt(data) {
        return this.client_context.cipher.update(data);
    }

    clientDecrypt(data) {
        return this.client_context.decipher.update(data);
    }

    serverEncrypt(data) {
        return this.server_context.cipher.update(data);
    }

    serverDecrypt(data) {
        return this.server_context.decipher.update(data);
    }
}

const PBKDF_salt0 = Buffer.from('F072FA3F66B410A135FAE8E6D1D43D5F', 'hex');
const PBKDF_salt1 = Buffer.from('BD0682C9FE79325BC73655F4174B996C', 'hex');

export class ClientEncryption extends Encryption {
    encrypt(data) {
        return this.clientEncrypt(data);
    }

    decrypt(data) {
        return this.serverDecrypt(data);
    }
}

export class ServerEncryption extends Encryption {
    encrypt(data) {
        return this.serverEncrypt(data);
    }

    decrypt(data) {
        return this.clientDecrypt(data);
    }
}
