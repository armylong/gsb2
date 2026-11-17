// 本机系统级 getaddrinfo 不可用（scutil --dns 无配置），
// 预加载此补丁：把 dns.lookup（走 getaddrinfo）替换为 dns.resolve4（走显式 DNS 服务器）。
// 仅用于本机 npm/vitest 等 Node 工具链，应用代码不依赖此文件。
const dns = require('node:dns');
dns.setServers(['223.5.5.5', '8.8.8.8', '1.1.1.1']);

const origLookup = dns.lookup;
function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  const wantAll = options.all === true;
  dns.resolve4(hostname, (err, addresses) => {
    if (err) {
      // 回退到原始 lookup（localhost 等本机名仍可能需要它）
      return origLookup(hostname, options, callback);
    }
    if (wantAll) {
      callback(null, addresses.map((address) => ({ address, family: 4 })));
    } else {
      callback(null, addresses[0], 4);
    }
  });
}
dns.lookup = patchedLookup;
const dnsPromises = require('node:dns/promises');
dnsPromises.lookup = (hostname, options) =>
  new Promise((resolve, reject) => {
    patchedLookup(hostname, options || {}, (err, address, family) => {
      if (err) reject(err);
      else if (options && options.all) resolve(address);
      else resolve({ address, family });
    });
  });
