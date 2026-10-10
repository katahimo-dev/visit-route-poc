/**
 * 開発用の補正（エミュレーター起動時だけ NODE_OPTIONS で読み込む）。
 * firebase-tools は HTTPS_PROXY があると NO_PROXY を無視して、ローカルのエミュレーター宛ての通信まで
 * プロキシに送ってしまう。undici の ProxyAgent を、NO_PROXY を守る EnvHttpProxyAgent に差し替える。
 * 外部への通信はこれまでどおりプロキシを通る。
 */
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const mod = origLoad.apply(this, arguments);
  if (request === 'undici' && mod && mod.EnvHttpProxyAgent && !mod.__honorNoProxy) {
    const Env = mod.EnvHttpProxyAgent;
    class HonorNoProxyAgent extends Env {
      constructor() {
        super();
      }
    }
    try {
      Object.defineProperty(mod, 'ProxyAgent', { value: HonorNoProxyAgent, configurable: true, writable: true });
      Object.defineProperty(mod, '__honorNoProxy', { value: true });
    } catch {
      // 書き換えられない版では何もしない
    }
  }
  return mod;
};
