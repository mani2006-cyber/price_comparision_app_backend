'use strict';
/** Every Redis key used by the monitor lives here (prefix "sm:") so nothing can collide with your app. */
const P = 'sm:';
module.exports = {
  statsMin: (min) => `${P}stats:m:${min}`,
  recent: `${P}recent`,
  block: (ip) => `${P}block:${ip}`,
  blockedZset: `${P}blocked:z`,
  cooldown: (k) => `${P}cd:${k}`,
  nonce: (n) => `${P}nonce:${n}`,
  dedupe: (id) => `${P}evt:${id}`,
  counter: (name, id, bucket) => `${P}cnt:${name}:${id}:${bucket}`,
  loginFail: (ip) => `${P}rl:login:${ip}`,
  topEndpoint: (min) => `${P}ep:${min}`,
};
