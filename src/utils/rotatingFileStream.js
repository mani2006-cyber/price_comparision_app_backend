'use strict';

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

class RotatingFileStream extends Writable {
    constructor(filePath, maxFileSizeBytes, retentionFiles) {
        super();
        this.filePath = filePath;
        this.maxFileSizeBytes = maxFileSizeBytes;
        this.retentionFiles = retentionFiles;
        this.currentSize = null;
        this.warningLogged = false;
    }

    _write(chunk, encoding, callback) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);

        this.append(data).then(
            () => {
                this.warningLogged = false;
                callback();
            },
            (err) => {
                this.currentSize = null;
                this.reportWriteFailure(err);
                callback();
            }
        );
    }

    async append(data) {
        if (data.length > this.maxFileSizeBytes) {
            throw new Error('Log record exceeds LOG_MAX_FILE_SIZE_BYTES');
        }

        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });

        if (this.currentSize === null) {
            try {
                this.currentSize = (await fs.promises.stat(this.filePath)).size;
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
                this.currentSize = 0;
            }
        }

        if (this.currentSize > 0 && this.currentSize + data.length > this.maxFileSizeBytes) {
            await this.rotate();
        }

        await fs.promises.appendFile(this.filePath, data, { mode: 0o600 });
        this.currentSize += data.length;
    }

    async rotate() {
        if (this.retentionFiles === 0) {
            try {
                await fs.promises.unlink(this.filePath);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
            }
            this.currentSize = 0;
            return;
        }

        for (let index = this.retentionFiles; index >= 1; index -= 1) {
            const source = index === 1 ? this.filePath : this.filePath + '.' + (index - 1);
            const destination = this.filePath + '.' + index;

            try {
                await fs.promises.unlink(destination);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
            }

            try {
                await fs.promises.rename(source, destination);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
            }
        }

        this.currentSize = 0;
    }

    reportWriteFailure(err) {
        if (this.warningLogged) {
            return;
        }
        this.warningLogged = true;

        try {
            process.stderr.write(
                'Persistent log write failed for ' + this.filePath + ': ' + err.message + '\n'
            );
        } catch (stderrError) {
            // Logging must not take down request handling if stderr is unavailable too.
        }
    }
}

class LogFileRouter extends Writable {
    constructor(streams) {
        super();
        this.streams = streams;
    }

    _write(chunk, encoding, callback) {
        let entry;
        try {
            entry = JSON.parse(chunk.toString('utf8'));
        } catch (err) {
            this.streams.application.reportWriteFailure(new Error('Pino emitted a non-JSON log record'));
            callback();
            return;
        }

        const destinations = [this.streams.application];
        if (entry.level >= 50) {
            destinations.push(this.streams.error);
        }
        if (entry.eventType === 'security') {
            destinations.push(this.streams.security);
        }
        if (entry.eventType === 'access') {
            destinations.push(this.streams.access);
        }

        let pending = destinations.length;
        const onDestinationWritten = () => {
            pending -= 1;
            if (pending === 0) {
                callback();
            }
        };

        destinations.forEach((destination) => {
            try {
                destination.write(chunk, onDestinationWritten);
            } catch (err) {
                destination.reportWriteFailure(err);
                onDestinationWritten();
            }
        });
    }

}

module.exports = { RotatingFileStream, LogFileRouter };
