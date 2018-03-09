import EthTx from 'ethereumjs-tx';
import {
  addHexPrefix,
  ecsign,
  ecrecover,
  sha3,
  hashPersonalMessage,
  toBuffer,
  pubToAddress
} from 'ethereumjs-util';
import { fromEtherWallet } from 'ethereumjs-wallet/thirdparty';
import { createDecipheriv, createHash } from 'crypto-browserify';
import { fromEthSale, fromPrivateKey, fromV3 } from 'ethereumjs-wallet';

require('buffer');

let wallet;

const KeystoreTypes = {
  presale: 'presale',
  utc: 'v2-v3-utc',
  v1Unencrypted: 'v1-unencrypted',
  v1Encrypted: 'v1-encrypted',
  v2Unencrypted: 'v2-unencrypted',
};

export function signRawTxWithPrivKey(privKey, t) {
  console.log(privKey);
  console.log(t);
  t.sign(privKey);
  return t.serialize();
}

export function signMessageWithPrivKeyV2(privKey, msg) {
  const hash = hashPersonalMessage(toBuffer(msg));
  const signed = ecsign(hash, privKey);
  const combined = Buffer.concat([
    Buffer.from(signed.r),
    Buffer.from(signed.s),
    Buffer.from([signed.v])
  ]);
  const combinedHex = combined.toString('hex');

  return addHexPrefix(combinedHex);
}

function determineKeystoreType(file) {
  const parsed = JSON.parse(file);
  if (parsed.encseed) {
    return KeystoreTypes.presale;
  } else if (parsed.Crypto || parsed.crypto) {
    return KeystoreTypes.utc;
  } else if (parsed.hash && parsed.locked === true) {
    return KeystoreTypes.v1Encrypted;
  } else if (parsed.hash && parsed.locked === false) {
    return KeystoreTypes.v1Unencrypted;
  } else if (parsed.publisher === 'MyEtherWallet') {
    return KeystoreTypes.v2Unencrypted;
  } else {
    throw new Error('Invalid keystore');
  }
}

const isKeystorePassRequired = (file) => {
  const keystoreType = determineKeystoreType(file);
  return (
    keystoreType === KeystoreTypes.presale ||
    keystoreType === KeystoreTypes.v1Encrypted ||
    keystoreType === KeystoreTypes.utc
  );
};

export function evp_kdf(data, salt, opts) {
  // A single EVP iteration, returns `D_i`, where block equlas to `D_(i-1)`
  function iter(block) {
    let hash = createHash(opts.digest || 'md5');
    hash.update(block);
    hash.update(data);
    hash.update(salt);
    block = hash.digest();
    for (let e = 1; e < (opts.count || 1); e++) {
      hash = createHash(opts.digest || 'md5');
      hash.update(block);
      block = hash.digest();
    }
    return block;
  }

  const keysize = opts.keysize || 16;
  const ivsize = opts.ivsize || 16;
  const ret = [];
  let i = 0;
  while (Buffer.concat(ret).length < keysize + ivsize) {
    ret[i] = iter(i === 0 ? new Buffer(0) : ret[i - 1]);
    i++;
  }
  const tmp = Buffer.concat(ret);
  return {
    key: tmp.slice(0, keysize),
    iv: tmp.slice(keysize, keysize + ivsize)
  };
}

export function decipherBuffer(decipher, data) {
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function decryptPrivKey(encprivkey, password) {
  const cipher = encprivkey.slice(0, 128);
  const decryptedCipher = decodeCryptojsSalt(cipher);
  const evp = evp_kdf(new Buffer(password), decryptedCipher.salt, {
    keysize: 32,
    ivsize: 16
  });
  const decipher = createDecipheriv('aes-256-cbc', evp.key, evp.iv);
  const privKey = decipherBuffer(decipher, new Buffer(decryptedCipher.ciphertext));

  return new Buffer(privKey.toString(), 'hex');
}

const EncryptedPrivateKeyWallet = (encryptedPrivateKey, password) =>
  signWrapper(fromPrivateKey(decryptPrivKey(encryptedPrivateKey, password)));

const PresaleWallet = (keystore, password) =>
  signWrapper(fromEthSale(keystore, password));

const MewV1Wallet = (keystore, password) =>
  signWrapper(fromEtherWallet(keystore, password));

const PrivKeyWallet = (privkey) => signWrapper(fromPrivateKey(privkey));

const UtcWallet = (keystore, password) => fromV3(keystore, password, true);

const getKeystoreWallet = (file, password) => {
  const parsed = JSON.parse(file);

  switch (determineKeystoreType(file)) {
    case KeystoreTypes.presale:
      return PresaleWallet(file, password);

    case KeystoreTypes.v1Unencrypted:
      return PrivKeyWallet(Buffer.from(parsed.private, 'hex'));

    case KeystoreTypes.v1Encrypted:
      return MewV1Wallet(file, password);

    case KeystoreTypes.v2Unencrypted:
      return PrivKeyWallet(Buffer.from(parsed.privKey, 'hex'));

    default:
      throw Error('Unknown wallet');
  }
};

export const signWrapper = (walletToWrap) =>
  Object.assign(walletToWrap, {
    signRawTransaction: (t) => signRawTxWithPrivKey(walletToWrap.getPrivateKey(), t),
    signMessage: (msg) => signMessageWithPrivKeyV2(walletToWrap.getPrivateKey(), msg),
    unlock: () => Promise.resolve()
  });

export function unlockKeystore(file, password) {
  const address = JSON.parse(file).address;
  if (determineKeystoreType(file) === KeystoreTypes.utc) {
    wallet = {
      address,
      ...signWrapper(UtcWallet(file, password)),
    }
  } else {
    wallet = {
      address,
      ...getKeystoreWallet(file, password),
    }
  }
  return wallet;
}

export const getWallet = () => {
  if (wallet) return wallet;
  else throw new Error('Keystore not unlocked');
};

export default {
  isKeystorePassRequired,
  unlockKeystore,
  getWallet,
};

// const ks = '{"version":3,"id":"b2b7ecab-f33c-405c-ac7f-ae9bd1edafc2","address":"2f797b1e6c8ae924738b0cc837556b8741e44d9e","Crypto":{"ciphertext":"fa4800c231422386c08869ffbd9b9f6f79e40ffa0a2ff81b5281cd1e8f90cfcc","cipherparams":{"iv":"f402f7e21b7f278b6a1e566868daec8e"},"cipher":"aes-128-ctr","kdf":"scrypt","kdfparams":{"dklen":32,"salt":"4480cc9b94595e9b046948b3adb7aab2fbb2379b9e103980e80c212a90575b29","n":8192,"r":8,"p":1},"mac":"55dd415fcb79486d1ac1c63aaed5e45452b412ade4d0ac2af84e6e1e4de802b3"}}';
// console.log(unlockKeystore(ks, 'Create New Wallet'));