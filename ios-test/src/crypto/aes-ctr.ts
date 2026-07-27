// AES-128-CTR/NoPadding using @noble/ciphers (replaces Web Crypto API)
// Java AES/CTR/NoPadding compatible: counter=key(16B), length=128 -> full 128-bit initial counter
import { ctr } from '@noble/ciphers/aes';
import { bytes as hexBytes } from '@noble/ciphers/utils';

export function aesCtrEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const aes = ctr(key, key); // counter = key (same as IvParameterSpec)
  return aes.encrypt(data);
}

export function aesCtrDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  // CTR is symmetric: encrypt = decrypt
  const aes = ctr(key, key);
  return aes.decrypt(data);
}
