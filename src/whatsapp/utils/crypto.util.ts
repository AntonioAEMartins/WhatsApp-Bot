import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';

export class CryptoUtil {
  private static readonly logger = new Logger('CryptoUtil');

  /**
   * Decrypt the AES key using a private key
   * @param encryptedAesKey Base64 encoded encrypted AES key
   * @param privateKey PEM formatted RSA private key
   * @returns Decrypted AES key as Buffer
   */
  static decryptAesKey(encryptedAesKey: string, privateKey: string): Buffer {
    try {
      if (!encryptedAesKey) {
        throw new Error('Encrypted AES key is empty or undefined');
      }

      // Log key info (without revealing private data)
      this.logger.debug(`Encrypted AES key length: ${encryptedAesKey.length}`);
      this.logger.debug(`Private key starts with: ${privateKey.substring(0, 30)}...`);
      
      // Decode the base64 encrypted AES key
      const encryptedAesKeyBuffer = Buffer.from(encryptedAesKey, 'base64');
      this.logger.debug(`Decoded AES key buffer length: ${encryptedAesKeyBuffer.length}`);
      
      // Decrypt using private key
      try {
        const decryptedAesKey = crypto.privateDecrypt(
          {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
          },
          encryptedAesKeyBuffer
        );
        
        this.logger.debug(`Decrypted AES key length: ${decryptedAesKey.length}`);
        return decryptedAesKey;
      } catch (cryptoError) {
        this.logger.error(`Crypto library error: ${cryptoError.message}`);
        throw new Error(`Failed to decrypt AES key: ${cryptoError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error in decryptAesKey: ${error.message}`);
      throw new Error(`Failed to decrypt AES key: ${error.message}`);
    }
  }

  /**
   * Decrypt the flow data using the AES key and initialization vector
   * @param encryptedFlowData Base64 encoded encrypted flow data
   * @param aesKey Decrypted AES key as Buffer
   * @param initialVector Base64 encoded initialization vector
   * @returns Decrypted flow data as string
   */
  static decryptFlowData(encryptedFlowData: string, aesKey: Buffer, initialVector: string): string {
    try {
      if (!encryptedFlowData) {
        throw new Error('Encrypted flow data is empty or undefined');
      }
      if (!aesKey || aesKey.length === 0) {
        throw new Error('AES key is empty or invalid');
      }
      if (!initialVector) {
        throw new Error('Initialization vector is empty or undefined');
      }

      this.logger.debug(`Encrypted flow data length: ${encryptedFlowData.length}`);
      this.logger.debug(`AES key length: ${aesKey.length}`);
      this.logger.debug(`IV length: ${initialVector.length}`);
      
      // Decode the base64 encrypted flow data and IV
      const encryptedFlowDataBuffer = Buffer.from(encryptedFlowData, 'base64');
      const ivBuffer = Buffer.from(initialVector, 'base64');
      
      this.logger.debug(`Decoded flow data buffer length: ${encryptedFlowDataBuffer.length}`);
      this.logger.debug(`Decoded IV buffer length: ${ivBuffer.length}`);
      
      if (ivBuffer.length !== 16) {
        throw new Error(`IV must be 16 bytes (got ${ivBuffer.length})`);
      }
      
      try {
        // According to WhatsApp documentation, we need to use AES-GCM
        // The last 16 bytes of the encrypted data is the authentication tag
        const TAG_LENGTH = 16;
        
        // Split the encrypted data into ciphertext and auth tag
        const ciphertext = encryptedFlowDataBuffer.slice(0, encryptedFlowDataBuffer.length - TAG_LENGTH);
        const authTag = encryptedFlowDataBuffer.slice(encryptedFlowDataBuffer.length - TAG_LENGTH);
        
        // Create decipher
        const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, ivBuffer);
        
        // Set the auth tag
        decipher.setAuthTag(authTag);
        
        // Decrypt the flow data
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        const result = decrypted.toString('utf8');
        this.logger.debug(`Decrypted data length: ${result.length}`);
        return result;
      } catch (cryptoError) {
        this.logger.error(`Crypto library error: ${cryptoError.message}`);
        throw new Error(`Failed to decrypt flow data: ${cryptoError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error in decryptFlowData: ${error.message}`);
      throw new Error(`Failed to decrypt flow data: ${error.message}`);
    }
  }

  /**
   * Encrypt data using the AES key and initialization vector
   * @param data String data to encrypt
   * @param aesKey Decrypted AES key as Buffer
   * @param initialVector Base64 encoded initialization vector
   * @returns Base64 encoded encrypted data
   */
  static encryptData(data: string, aesKey: Buffer, initialVector: string): string {
    try {
      if (!data) {
        throw new Error('Data to encrypt is empty or undefined');
      }
      if (!aesKey || aesKey.length === 0) {
        throw new Error('AES key is empty or invalid');
      }
      if (!initialVector) {
        throw new Error('Initialization vector is empty or undefined');
      }

      this.logger.debug(`Data to encrypt length: ${data.length}`);
      this.logger.debug(`AES key length: ${aesKey.length}`);
      this.logger.debug(`IV length: ${initialVector.length}`);
      
      // Decode base64 IV
      const ivBuffer = Buffer.from(initialVector, 'base64');
      
      if (ivBuffer.length !== 16) {
        throw new Error(`IV must be 16 bytes (got ${ivBuffer.length})`);
      }
      
      // According to WhatsApp documentation, we need to invert the IV bits for response
      const flippedIV = Buffer.from(ivBuffer.map(byte => ~byte));
      
      try {
        // Create cipher with AES-128-GCM algorithm
        const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIV);
        
        // Encrypt the data
        let encrypted = cipher.update(data, 'utf8');
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        // Get the auth tag and append it to the encrypted data
        const authTag = cipher.getAuthTag();
        const encryptedWithTag = Buffer.concat([encrypted, authTag]);
        
        // Convert to base64
        const result = encryptedWithTag.toString('base64');
        this.logger.debug(`Encrypted data length: ${result.length}`);
        return result;
      } catch (cryptoError) {
        this.logger.error(`Crypto library error: ${cryptoError.message}`);
        throw new Error(`Failed to encrypt data: ${cryptoError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error in encryptData: ${error.message}`);
      throw new Error(`Failed to encrypt data: ${error.message}`);
    }
  }
} 