import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export type SecretContext = { tenantId: string; userId: string; purpose: string };

const envelopeSchema = z
  .object({
    version: z.literal(1),
    keyId: z.string().min(1),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();

export class SecretVault {
  private keys: ReadonlyMap<string, Buffer>;
  private activeKeyId: string;

  constructor(activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    if (
      !activeKeyId ||
      !keys.has(activeKeyId) ||
      [...keys.values()].some((key) => key.length !== 32)
    ) {
      throw new Error('Vault keys must be 32 bytes and include the active key.');
    }
    this.keys = new Map([...keys].map(([id, key]) => [id, Buffer.from(key)]));
    this.activeKeyId = activeKeyId;
  }

  private context(context: SecretContext, keyId: string): Buffer {
    if (!context.tenantId || !context.userId || !context.purpose)
      throw new Error('A complete secret context is required.');
    return Buffer.from(
      JSON.stringify(['branchlight', 1, keyId, context.tenantId, context.userId, context.purpose]),
    );
  }

  encrypt(value: string, context: SecretContext): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(this.context(context, this.activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({
      version: 1,
      keyId: this.activeKeyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
  }

  decrypt(value: string, context: SecretContext): string {
    try {
      const envelope = envelopeSchema.parse(JSON.parse(value));
      const key = this.keys.get(envelope.keyId);
      if (!key) throw new Error('Unknown key.');
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope.');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(this.context(context, envelope.keyId));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('The stored credential could not be authenticated.');
    }
  }
}
