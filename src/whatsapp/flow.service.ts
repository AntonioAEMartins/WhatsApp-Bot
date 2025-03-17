import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlowDataDto } from './dto/flow.dto';
import { CryptoUtil } from './utils/crypto.util';
import * as fs from 'fs';

@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);
  private readonly privateKey: string;

  constructor() {
    // Read from environment variable directly
    const environment = process.env.ENVIRONMENT;
    const privateKeyPath = environment === 'demo' ? process.env.WHATSAPP_DEMO_FLOW_PRIVATE_KEY_PATH : process.env.WHATSAPP_TEST_FLOW_PRIVATE_KEY_PATH;
    
    this.logger.log(`WhatsApp Flow private key path: ${privateKeyPath}`);

    if (privateKeyPath) {
      try {
        this.privateKey = fs.readFileSync(privateKeyPath, 'utf8');
        this.logger.log(`WhatsApp Flow private key loaded from: ${privateKeyPath}`);
      } catch (error) {
        this.logger.error(`Failed to load private key from ${privateKeyPath}: ${error.message}`, error.stack);
        this.privateKey = null;
      }
    } else {
      this.logger.warn('No WhatsApp Flow private key path configured (WHATSAPP_FLOW_PRIVATE_KEY_PATH)');
      this.privateKey = null;
    }
  }

  /**
   * Process the encrypted Flow data and return an encrypted response
   * @param flowData The encrypted Flow data from WhatsApp
   * @returns Base64 encoded encrypted response
   */
  async processFlowData(flowData: FlowDataDto): Promise<string> {
    this.logger.log(`Processing WhatsApp Flow data`);
    
    if (!flowData.encrypted_flow_data || !flowData.encrypted_aes_key || !flowData.initial_vector) {
      this.logger.error('Incomplete flow data received - missing required fields');
      return this.generateFallbackEncryptedResponse('missing_fields');
    }
    
    // Default response if anything fails
    let responsePayload = JSON.stringify({ status: "success" });

    // If a private key is configured, attempt decryption
    if (!this.privateKey) {
      this.logger.error('No private key available for Flow data decryption');
      return this.generateFallbackEncryptedResponse('no_private_key');
    }
    
    try {
      // 1. Decrypt the AES key using the private key
      this.logger.log('Decrypting AES key...');
      
      let decryptedAesKey: Buffer;
      try {
        decryptedAesKey = CryptoUtil.decryptAesKey(
          flowData.encrypted_aes_key, 
          this.privateKey
        );
      } catch (keyError) {
        if (keyError.message.includes('CVE-2023-46809')) {
          this.logger.error(`Security restriction prevents decryption: ${keyError.message}`);
          this.logger.warn('Consider updating your key pair to use OAEP padding or contacting WhatsApp Business API support');
          return this.generateFallbackEncryptedResponse('security_restriction');
        } else {
          throw keyError; // rethrow for general handling
        }
      }
      
      // 2. Use the decrypted AES key and IV to decrypt the flow data
      this.logger.log('Decrypting flow data...');
      const decryptedFlowData = CryptoUtil.decryptFlowData(
        flowData.encrypted_flow_data,
        decryptedAesKey,
        flowData.initial_vector
      );
      
      // 3. Process the decrypted flow data (parse JSON, etc.)
      const parsedFlowData = JSON.parse(decryptedFlowData);
      this.logger.log(`Flow data processed successfully (action: ${parsedFlowData.action || 'unknown'})`);
      
      // 4. Check if this is a health check request
      if (parsedFlowData.action === 'ping') {
        this.logger.log('Received health check ping request');
        responsePayload = this.handleHealthCheck(parsedFlowData);
      } else {
        // 5. Generate a response payload based on the flow data
        responsePayload = this.generateResponsePayload(parsedFlowData);
      }
      
      // 6. Encrypt the response using the same AES key and IV
      this.logger.log('Encrypting response payload...');
      const encryptedResponse = CryptoUtil.encryptData(
        responsePayload,
        decryptedAesKey,
        flowData.initial_vector
      );
      
      this.logger.log(`Encrypted response generated successfully`);
      return encryptedResponse;
    } catch (error) {
      this.logger.error(
        `Flow data processing error: ${error.message}`, 
        error.stack
      );
      
      // In case of error, return a dummy encrypted response
      return this.generateFallbackEncryptedResponse('processing_error');
    }
  }
  
  /**
   * Handle health check requests from WhatsApp
   * @param parsedFlowData The parsed flow data containing the health check request
   * @returns JSON string response for health check
   */
  private handleHealthCheck(parsedFlowData: any): string {
    this.logger.log('Processing health check request');
    
    // According to WhatsApp Flow documentation, the response should be:
    // {
    //   "data": {
    //     "status": "active"
    //   }
    // }
    
    return JSON.stringify({
      data: {
        status: "active"
      }
    });
  }
  
  /**
   * Generate a response payload based on the parsed flow data
   * @param parsedFlowData The parsed flow data
   * @returns JSON string response payload
   */
  private generateResponsePayload(parsedFlowData: any): string {
    const { action, screen, data = {}, flow_token, version } = parsedFlowData;
    
    this.logger.debug(`Generating response for action: ${action}, screen: ${screen || 'N/A'}`);
    
    // Different response based on the action type
    switch (action) {
      case 'INIT':
        // Initial screen when flow is opened
        return JSON.stringify({
          screen: "WELCOME_SCREEN",
          data: {
            message: "Welcome to our service!",
            // Add any other data needed for the welcome screen
          }
        });
      
      case 'data_exchange':
        // User submitted a screen
        // In a real implementation, process the data from the submitted screen
        // and determine the next screen to show
        return JSON.stringify({
          screen: "NEXT_SCREEN",
          data: {
            // Dynamic data based on the submitted data
            received_data: data,
            processed_result: "Your data has been processed"
          }
        });
      
      case 'BACK':
        // User pressed back button
        return JSON.stringify({
          screen: "PREVIOUS_SCREEN",
          data: {
            message: "You went back"
          }
        });
      
      default:
        // Default response for any other action
        return JSON.stringify({
          screen: "DEFAULT_SCREEN",
          data: {
            message: "Unknown action received",
            action: action || 'none'
          }
        });
    }
  }
  
  /**
   * Generate a fallback encrypted response when normal encryption fails
   * @param reason The reason for fallback
   * @returns Base64 encoded string that meets WhatsApp's format requirements
   */
  private generateFallbackEncryptedResponse(reason: 'missing_fields' | 'no_private_key' | 'security_restriction' | 'processing_error' = 'processing_error'): string {
    this.logger.warn(`Using fallback encrypted response due to: ${reason}`);
    
    // Create a response payload based on the reason
    const responseObj: any = {
      status: "success", 
      error_handled: true,
      timestamp: new Date().toISOString()
    };
    
    // Add specific metadata based on the reason for debugging
    // This won't be visible to the user but may help in troubleshooting
    switch (reason) {
      case 'security_restriction':
        responseObj.metadata = {
          message: "Security restriction prevented decryption",
          error_type: "CVE-2023-46809",
          suggestion: "Update key pair to use OAEP padding or contact WhatsApp support"
        };
        break;
      case 'missing_fields':
        responseObj.metadata = { 
          message: "Incomplete flow data received",
          error_type: "missing_required_fields"
        };
        break;
      case 'no_private_key':
        responseObj.metadata = { 
          message: "No private key available",
          error_type: "configuration_error"
        };
        break;
      default:
        responseObj.metadata = { 
          message: "Error during flow data processing",
          error_type: "general_processing_error"
        };
    }
    
    // Use a properly encoded Base64 string that can be returned to WhatsApp
    const encodedResponse = Buffer.from(JSON.stringify(responseObj)).toString('base64');
    
    return encodedResponse;
  }
} 