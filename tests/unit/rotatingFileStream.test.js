'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RotatingFileStream, LogFileRouter } = require('../../src/utils/rotatingFileStream');

describe('RotatingFileStream', function() {
    let testDirectory;

    beforeEach(function() {
        testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-compare-logs-'));
    });

    afterEach(function() {
        fs.rmSync(testDirectory, { recursive: true, force: true });
    });

    it('rotates at the configured size and retains the configured number of backups', async function() {
        const filePath = path.join(testDirectory, 'application.log');
        const stream = new RotatingFileStream(filePath, 60, 1);

        await new Promise(function(resolve) {
            stream.write('a'.repeat(40), resolve);
        });
        await new Promise(function(resolve) {
            stream.write('b'.repeat(30), resolve);
        });
        await new Promise(function(resolve) {
            stream.write('c'.repeat(31), resolve);
        });
        stream.end();

        expect(fs.readFileSync(filePath, 'utf8')).toBe('c'.repeat(31));
        expect(fs.readFileSync(filePath + '.1', 'utf8')).toBe('b'.repeat(30));
        expect(fs.existsSync(filePath + '.2')).toBe(false);
    });

    it('continues the write callback when the log directory is unavailable', async function() {
        const blockedPath = path.join(testDirectory, 'not-a-directory');
        fs.writeFileSync(blockedPath, 'file');
        const stream = new RotatingFileStream(path.join(blockedPath, 'application.log'), 60, 1);
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(function() { return true; });

        await expect(new Promise(function(resolve) {
            stream.write('log line', resolve);
        })).resolves.toBeNull();

        expect(stderrSpy).toHaveBeenCalled();
        stderrSpy.mockRestore();
    });

    it('routes structured records to the appropriate log files', async function() {
        const makeStream = function(fileName) {
            return new RotatingFileStream(path.join(testDirectory, fileName), 1000, 1);
        };
        const streams = {
            application: makeStream('application.log'),
            error: makeStream('error.log'),
            security: makeStream('security.log'),
            access: makeStream('access.log'),
        };
        const router = new LogFileRouter(streams);
        const records = [
            { level: 30, eventType: 'application', msg: 'app' },
            { level: 50, eventType: 'application', msg: 'error' },
            { level: 40, eventType: 'security', msg: 'security' },
            { level: 30, eventType: 'access', msg: 'access' },
        ];

        for (const record of records) {
            await new Promise(function(resolve) {
                router.write(JSON.stringify(record) + '\n', resolve);
            });
        }
        await new Promise(function(resolve) { router.end(resolve); });
        await Promise.all(Object.keys(streams).map(function(key) {
            return new Promise(function(resolve) { streams[key].end(resolve); });
        }));

        expect(fs.readFileSync(path.join(testDirectory, 'application.log'), 'utf8'))
            .toContain('"msg":"app"');
        expect(fs.readFileSync(path.join(testDirectory, 'application.log'), 'utf8'))
            .toContain('"msg":"error"');
        expect(fs.readFileSync(path.join(testDirectory, 'error.log'), 'utf8'))
            .toContain('"msg":"error"');
        expect(fs.readFileSync(path.join(testDirectory, 'security.log'), 'utf8'))
            .toContain('"msg":"security"');
        expect(fs.readFileSync(path.join(testDirectory, 'access.log'), 'utf8'))
            .toContain('"msg":"access"');
    });
});
