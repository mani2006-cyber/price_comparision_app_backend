// tests/unit/services/aiComparison.service.test.js
//
// Unit tests for aiComparison.service.js. The whole point of this module
// is that it NEVER throws and NEVER blocks compare.service.js - every
// failure mode (no key, no matches, network error, timeout, empty
// response) must resolve to null, not reject.

'use strict';

jest.mock('../../../src/config/env', function() {
    return {
        openRouter: {
            enabled: true,
            apiKey: 'test-key',
            model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
            timeoutMs: 200,
        },
    };
});

const mockSend = jest.fn();

// aiComparison.service.js gets its client through openRouterClient.js
// specifically so this mock works - see that file's own comment for why
// mocking @openrouter/sdk directly does NOT work in this project (no
// babel transform to make its dynamic import() interceptable by Jest).
jest.mock('../../../src/services/openRouterClient', function() {
    return {
        getClient: jest.fn().mockResolvedValue({ chat: { send: mockSend } }),
    };
});

const config = require('../../../src/config/env');
const aiComparisonService = require('../../../src/services/aiComparison.service');

const ORIGINAL = { marketplace: 'amazon', title: 'iPhone 16 128GB', currentPrice: 68900 };
const MATCHES = [{ marketplace: 'flipkart', title: 'Apple iPhone 16 (128 GB)', currentPrice: 65900 }];

beforeEach(function() {
    jest.clearAllMocks();
    config.openRouter.enabled = true;
});

describe('generateComparisonSummary', function() {
    it('returns null immediately when OpenRouter is not configured, without calling the SDK', async function() {
        config.openRouter.enabled = false;

        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(result).toBeNull();
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when there are no matches to compare against, without calling the SDK', async function() {
        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, []);

        expect(result).toBeNull();
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns the trimmed summary text on a successful string-content response', async function() {
        mockSend.mockResolvedValue({
            choices: [{ message: { content: '  Flipkart is ₹3000 cheaper for the same phone.  ' } }],
        });

        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(result).toBe('Flipkart is ₹3000 cheaper for the same phone.');
    });

    it('extracts text from an array-of-parts content shape', async function() {
        mockSend.mockResolvedValue({
            choices: [{ message: { content: [{ type: 'text', text: 'Amazon wins on price.' }] } }],
        });

        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(result).toBe('Amazon wins on price.');
    });

    it('returns null (never throws) when the SDK call rejects', async function() {
        mockSend.mockRejectedValue(new Error('rate limited'));

        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(result).toBeNull();
    });

    it('returns null (never throws) when the response has no usable content', async function() {
        mockSend.mockResolvedValue({ choices: [{ message: { content: '' } }] });

        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(result).toBeNull();
    });

    it('returns null when the call hangs past the configured timeout', async function() {
        mockSend.mockImplementation(function() {
            return new Promise(function() { /* never resolves */ });
        });

        const result = await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(result).toBeNull();
    });

    it('sends the configured model and includes both products in the prompt', async function() {
        mockSend.mockResolvedValue({ choices: [{ message: { content: 'Summary.' } }] });

        await aiComparisonService.generateComparisonSummary(ORIGINAL, MATCHES);

        expect(mockSend).toHaveBeenCalledTimes(1);
        const callArg = mockSend.mock.calls[0][0];
        expect(callArg.chatRequest.model).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
        expect(callArg.chatRequest.stream).toBe(false);
        const promptText = callArg.chatRequest.messages[0].content;
        expect(promptText).toContain('iPhone 16 128GB');
        expect(promptText).toContain('Apple iPhone 16 (128 GB)');
        expect(promptText).toContain('68900');
        expect(promptText).toContain('65900');
    });
});
