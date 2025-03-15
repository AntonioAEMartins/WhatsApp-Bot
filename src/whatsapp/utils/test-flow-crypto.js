/**
 * Test script to verify the WhatsApp Flow decryption functionality
 * Run with: node test-flow-crypto.js
 */

const crypto = require('crypto');
const fs = require('fs');

// Load private key from environment variable or file
const privateKeyPath = process.env.WHATSAPP_TEST_FLOW_PRIVATE_KEY_PATH || 
                      process.env.WHATSAPP_DEMO_FLOW_PRIVATE_KEY_PATH;

if (!privateKeyPath) {
  console.error('No private key path provided. Set WHATSAPP_TEST_FLOW_PRIVATE_KEY_PATH environment variable.');
  process.exit(1);
}

console.log(`Loading private key from: ${privateKeyPath}`);
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

// Sample encrypted data (replace with actual test data if available)
// Or use dummy data for testing the different decryption methods
const generateDummyEncryptedData = () => {
  // Create a dummy AES key
  const aesKey = crypto.randomBytes(16); // 128 bits
  
  // Encrypt the AES key with different methods to test our decryption function
  const publicKey = crypto.createPublicKey({
    key: privateKey,
    format: 'pem',
  });
  
  console.log('Generating test data with different encryption methods...');
  
  // SHA-256 OAEP
  const sha256EncryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  ).toString('base64');
  
  // SHA-1 OAEP
  const sha1EncryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    },
    aesKey
  ).toString('base64');
  
  // PKCS1 padding
  const pkcs1EncryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    aesKey
  ).toString('base64');
  
  return {
    aesKey,
    sha256EncryptedKey,
    sha1EncryptedKey,
    pkcs1EncryptedKey
  };
};

// Decrypt AES key with multiple methods to find which one works
const decryptAesKey = (encryptedAesKey, privateKey) => {
  console.log(`Attempting to decrypt AES key (length: ${encryptedAesKey.length})`);
  
  // Decode the base64 encrypted AES key
  const encryptedAesKeyBuffer = Buffer.from(encryptedAesKey, 'base64');
  
  // Try with SHA-256 first
  try {
    console.log('Trying SHA-256 OAEP padding...');
    const decryptedAesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      encryptedAesKeyBuffer
    );
    console.log(`✅ SHA-256 OAEP decryption succeeded (length: ${decryptedAesKey.length})`);
    return { success: true, method: 'SHA-256 OAEP', key: decryptedAesKey };
  } catch (sha256Error) {
    console.log(`❌ SHA-256 OAEP decryption failed: ${sha256Error.message}`);
    
    // Try with SHA-1
    try {
      console.log('Trying SHA-1 OAEP padding...');
      const decryptedAesKey = crypto.privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha1'
        },
        encryptedAesKeyBuffer
      );
      console.log(`✅ SHA-1 OAEP decryption succeeded (length: ${decryptedAesKey.length})`);
      return { success: true, method: 'SHA-1 OAEP', key: decryptedAesKey };
    } catch (sha1Error) {
      console.log(`❌ SHA-1 OAEP decryption failed: ${sha1Error.message}`);
      
      // Try with PKCS1 padding as last resort
      try {
        console.log('Trying PKCS1 padding...');
        const decryptedAesKey = crypto.privateDecrypt(
          {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_PADDING
          },
          encryptedAesKeyBuffer
        );
        console.log(`✅ PKCS1 padding decryption succeeded (length: ${decryptedAesKey.length})`);
        return { success: true, method: 'PKCS1', key: decryptedAesKey };
      } catch (pkcs1Error) {
        console.log(`❌ PKCS1 padding decryption failed: ${pkcs1Error.message}`);
        return { success: false, error: 'All decryption methods failed' };
      }
    }
  }
};

// Main test function
const runTests = () => {
  console.log('Starting WhatsApp Flow decryption test...');
  
  const testData = generateDummyEncryptedData();
  
  // Test each encryption method
  console.log('\n=== Testing SHA-256 OAEP ===');
  const sha256Result = decryptAesKey(testData.sha256EncryptedKey, privateKey);
  
  console.log('\n=== Testing SHA-1 OAEP ===');
  const sha1Result = decryptAesKey(testData.sha1EncryptedKey, privateKey);
  
  console.log('\n=== Testing PKCS1 Padding ===');
  const pkcs1Result = decryptAesKey(testData.pkcs1EncryptedKey, privateKey);
  
  // Summary
  console.log('\n=== Test Results ===');
  console.log(`SHA-256 OAEP: ${sha256Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`SHA-1 OAEP: ${sha1Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`PKCS1 Padding: ${pkcs1Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  
  // Recommendation
  const allSuccessful = [sha256Result.success, sha1Result.success, pkcs1Result.success];
  const recommendedMethod = allSuccessful.every(result => result === true) 
    ? 'SHA-256 OAEP (most secure)'
    : sha256Result.success ? 'SHA-256 OAEP' 
    : sha1Result.success ? 'SHA-1 OAEP'
    : pkcs1Result.success ? 'PKCS1 Padding'
    : 'None - all methods failed';
  
  console.log(`\nRecommended method: ${recommendedMethod}`);
  
  if (recommendedMethod === 'None - all methods failed') {
    console.error('All decryption methods failed. Check your keys and encryption format.');
    process.exit(1);
  }
};

runTests(); 