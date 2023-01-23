import WebSocket = require('ws');
import tickerBTCUSD from '../test/fixtures/ws/ticker/BTC-USD.json';
import statusPayload from '../test/fixtures/ws/status/status.json';
import l2snapshotBTCUSD from '../test/fixtures/ws/level2/snapshot.json';
import emptySubscriptions from '../test/fixtures/ws/empty-subscriptions.json';
import {
  WebSocketChannelName,
  WebSocketClient,
  WebSocketEvent,
  WebSocketRequestType,
  WebSocketResponseType,
  WebSocketRequest,
  WebSocketChannel,
  WebSocketErrorMessage,
} from './WebSocketClient';
import ReconnectingWebSocket from 'reconnecting-websocket';
import {RESTClient} from '.';

const WEBSOCKET_PORT = 8087;
const WEBSOCKET_URL = `ws://localhost:${WEBSOCKET_PORT}`;

let server: WebSocket.Server;

describe('WebSocketClient', () => {
  function createWebSocketClient(url: string = WEBSOCKET_URL): WebSocketClient {
    const sig = (): any => {
      return Promise.resolve({
        key: '',
        signature: '',
        timestamp: Date.now() / 1000,
      });
    };
    return new WebSocketClient(
      url,
      sig,
      new RESTClient(
        {
          REST_ADV_TRADE: 'https://api.coinbase.com/api/v3',
          REST_SIWC: 'https://api.coinbase.com/v2',
          WebSocket: url,
        },
        sig
      )
    );
  }

  beforeEach(done => {
    server = new WebSocket.Server({port: WEBSOCKET_PORT});
    server.on('listening', () => done());
  });

  afterEach(done => {
    if (server) {
      server.close(error => {
        if (error) {
          done.fail(error);
        } else {
          done();
        }
      });
    } else {
      done();
    }
  });

  describe('connect', () => {
    it('attaches an error listener', done => {
      const invalidUrl = 'ws://localhost:50001';
      const ws = createWebSocketClient(invalidUrl);
      ws.on(WebSocketEvent.ON_ERROR, () => {
        /**
         * TODO:
         * An asynchronous function called its 'done' callback more than once. This is a bug in the spec, beforeAll,
         * beforeEach, afterAll, or afterEach function in question. This will be treated as an error in a future
         * version. See:
         * https://jasmine.github.io/tutorials/upgrading_to_Jasmine_4.0#deprecations-due-to-calling-done-multiple-times
         */
        done();
      });
      ws.connect();
    });

    it('throws an error when trying to overwrite an existing connection', done => {
      const ws = createWebSocketClient();
      ws.connect();
      try {
        ws.connect();
        done.fail('No error has been thrown');
      } catch (error) {
        done();
      }
    });

    it('supports custom reconnect options', async () => {
      const ws = createWebSocketClient();
      const socket = ws.connect({startClosed: true});
      expect(socket.readyState).toBe(ReconnectingWebSocket.CLOSED);
    });
  });

  describe('connected', () => {
    it('returns false when called before the connection is created', done => {
      const ws = createWebSocketClient();
      expect(ws.connected).toBe(false);
      done();
    });

    // TODO: This test appears to be flaky
    it('returns true when called after the connection is created', done => {
      const ws = createWebSocketClient();

      ws.on(WebSocketEvent.ON_CLOSE, () => {
        done();
      });

      ws.on(WebSocketEvent.ON_OPEN, () => {
        expect(ws.connected).toBe(true);

        ws.disconnect();
      });

      ws.connect();
    });

    // TODO: This test appears to be flaky
    it('returns false when called after the connection is closed', done => {
      const ws = createWebSocketClient();

      ws.on(WebSocketEvent.ON_CLOSE, () => {
        expect(ws.connected).toBe(false);
        done();
      });

      ws.on(WebSocketEvent.ON_OPEN, () => {
        ws.disconnect();
      });

      ws.connect();
    });
  });

  describe('constructor', () => {
    it('it signals an event when the WebSocket connection is established', done => {
      const ws = createWebSocketClient();
      ws.on(WebSocketEvent.ON_OPEN, () => {
        ws.disconnect();
        done();
      });
      ws.connect();
    });
  });

  describe('disconnect', () => {
    it('does not do anything if there is no existing connection', () => {
      const ws = createWebSocketClient();
      const onClose = jasmine.createSpy('onClose');

      ws.on(WebSocketEvent.ON_CLOSE, () => {
        onClose();
      });

      ws.disconnect();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('emits an event when an existing connection gets closed', done => {
      const ws = createWebSocketClient();

      ws.on(WebSocketEvent.ON_CLOSE, () => {
        done();
      });

      ws.on(WebSocketEvent.ON_OPEN, () => {
        ws.disconnect();
      });

      ws.connect();
    });
  });

  describe('sendMessage', () => {
    it('does not send a message when there is no active connection', async () => {
      const ws = createWebSocketClient();
      try {
        await ws.sendMessage({
          channel: WebSocketChannelName.TICKER,
          type: WebSocketRequestType.UNSUBSCRIBE,
        });
        fail('No error has been thrown');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('subscribe', () => {
    function mockWebSocketResponse(
      done: DoneFn,
      channels: WebSocketChannel | WebSocketChannel[],
      payload: Object
    ): WebSocketClient {
      server.on('connection', ws => {
        ws.on('message', (message: string) => {
          const request = JSON.parse(message) as WebSocketRequest;

          if (request.type === WebSocketRequestType.SUBSCRIBE) {
            // Send subscription confirmation
            server.clients.forEach(client =>
              client.send(
                JSON.stringify({
                  channels: request.channel,
                  type: WebSocketResponseType.SUBSCRIPTIONS,
                })
              )
            );
            // Send event for subscription
            server.clients.forEach(client => client.send(JSON.stringify(payload)));
          }

          if (request.type === WebSocketRequestType.UNSUBSCRIBE) {
            // Send unsubscribe confirmation
            server.clients.forEach(client => client.send(JSON.stringify(emptySubscriptions)));
          }
        });
      });

      const ws = createWebSocketClient();
      ws.on(WebSocketEvent.ON_SUBSCRIPTION_UPDATE, subscriptions => {
        // Disconnect when there are no more open subscriptions
        if (subscriptions.channels.length === 0) {
          ws.disconnect();
        }
      });
      ws.on(WebSocketEvent.ON_CLOSE, () => {
        done();
      });
      ws.on(WebSocketEvent.ON_MESSAGE_ERROR, (wsError: WebSocketErrorMessage) => done.fail(wsError.message));
      // Send subscription once the WebSocket is ready
      ws.on(WebSocketEvent.ON_OPEN, () => ws.subscribe(channels));
      return ws;
    }

    it('receives typed messages from "status" channel', (done: DoneFn) => {
      const channel = {
        channel: WebSocketChannelName.STATUS,
      };

      const ws = mockWebSocketResponse(done, channel, statusPayload);

      ws.on(WebSocketEvent.ON_MESSAGE_STATUS, async message => {
        // expect(message.currencies[2].details.sort_order).toBe(48);
        // expect(message.products[72].id).toBe('XRP-USD');
        expect(message).toBeDefined();
        await ws.unsubscribe(channel.channel);
      });

      ws.connect();
    });

    it('receives typed messages from "ticker" channel', done => {
      const channel = {
        channel: WebSocketChannelName.TICKER,
        product_ids: ['BTC-USD'],
      };

      const ws = mockWebSocketResponse(done, channel, tickerBTCUSD);

      ws.on(WebSocketEvent.ON_MESSAGE_TICKER, async tickerMessage => {
        expect(tickerMessage).toBeDefined();
        await ws.unsubscribe(channel);
      });

      ws.connect();
    });

    // TODO: This test appears to be flaky
    it('receives typed "snapshot" messages from "level2" channel', done => {
      const channel = {
        channel: WebSocketChannelName.LEVEL2,
        product_ids: ['BTC-USD'],
      };

      const ws = mockWebSocketResponse(done, channel, l2snapshotBTCUSD);

      ws.on(WebSocketEvent.ON_MESSAGE_L2SNAPSHOT, async snapshotMessage => {
        expect(snapshotMessage).toBeDefined();
        await ws.unsubscribe(channel);
      });

      ws.connect();
    });

    it('receives typed "ticker" messages from the special "ticker_1000" channel', done => {
      const channel = {
        channel: WebSocketChannelName.TICKER_1000,
        product_ids: ['BTC-USD'],
      };

      const ws = mockWebSocketResponse(done, channel, tickerBTCUSD);

      ws.on(WebSocketEvent.ON_MESSAGE_TICKER, async tickerMessage => {
        expect(tickerMessage.product_id).toBe('BTC-USD');
        await ws.unsubscribe(channel);
      });

      ws.connect();
    });

    it('receives typed error messages', done => {
      server.on('connection', ws => {
        ws.on('message', (message: string) => {
          const request = JSON.parse(message);

          if (request.type === WebSocketRequestType.SUBSCRIBE) {
            const response = JSON.stringify({
              message: 'Failed to subscribe',
              reason: 'user channel requires authentication',
              type: WebSocketResponseType.ERROR,
            });

            server.clients.forEach(client => {
              client.send(response);
            });
          }
        });
      });

      const ws = createWebSocketClient();

      ws.on(WebSocketEvent.ON_MESSAGE_ERROR, async errorMessage => {
        expect(errorMessage.type).toBe(WebSocketResponseType.ERROR);
        await ws.disconnect();
        done();
      });

      ws.on(WebSocketEvent.ON_OPEN, async () => {
        await ws.subscribe({
          channel: WebSocketChannelName.USER,
          product_ids: ['BTC-USD'],
        });
      });

      ws.connect();
    });

    it('does not throw an exception when disconnect is called immediately after an awaited subscribe', done => {
      const ws = createWebSocketClient();

      const channel: WebSocketChannel = {
        channel: WebSocketChannelName.TICKER,
        product_ids: ['BTC-USD', 'ETH-USD'],
      };

      ws.on(WebSocketEvent.ON_OPEN, async () => {
        await ws.subscribe(channel);

        expect(() => {
          ws.disconnect();
        }).not.toThrow();
      });

      ws.on(WebSocketEvent.ON_CLOSE, () => {
        done();
      });

      ws.connect();
    });
  });

  describe('unsubscribe', () => {
    // TODO: This test appears to be flaky
    it('unsubscribes from all products on a channel', done => {
      server.on('connection', socket => {
        socket.on('message', (message: string) => {
          const request = JSON.parse(message);

          if (request.type === WebSocketRequestType.UNSUBSCRIBE) {
            const response = JSON.stringify(emptySubscriptions);
            server.clients.forEach(client => client.send(response));
          }
        });
      });

      const ws = createWebSocketClient();

      ws.on(WebSocketEvent.ON_SUBSCRIPTION_UPDATE, async subscriptions => {
        if (subscriptions.channels.length === 0) {
          await ws.disconnect();
        }
      });

      ws.on(WebSocketEvent.ON_CLOSE, () => {
        done();
      });

      ws.on(WebSocketEvent.ON_OPEN, () => ws.unsubscribe(WebSocketChannelName.TICKER));

      ws.connect();
    });
  });

  describe('setupHeartbeat', () => {
    // TODO: This test appears to be flaky
    it('sends ping messages within a defined interval', done => {
      server.on('connection', socket => {
        socket.on('ping', async () => {
          await ws.disconnect();
          done();
        });
      });

      const ws = createWebSocketClient();
      ws['pingTime'] = 100;

      ws.connect();
    });
  });

  describe('heartbeat', () => {
    it('resets pong timeouts', () => {
      const ws = createWebSocketClient();
      ws['pongTimeout'] = setTimeout(() => {
        fail('I should not get invoked');
      }, 1000);
      ws['heartbeat']();
    });
  });

  describe('onPongTimeout', () => {
    it('does not fail when there is no active socket', () => {
      const ws = createWebSocketClient();
      ws['onPongTimeout']();
    });

    it('reconnects a socket when the pong timeout is exceeded', () => {
      const ws = createWebSocketClient();
      ws.connect();
      ws['onPongTimeout']();
    });
  });

  describe('cleanupListener', () => {
    it('removes ping & pong listener', () => {
      const ws = createWebSocketClient();

      ws['pingInterval'] = setInterval(() => {
        fail('I should not get invoked');
      }, 1000);

      ws['pongTimeout'] = setTimeout(() => {
        fail('I should not get invoked');
      }, 1000);

      ws['cleanupListener']();
    });
  });
});
