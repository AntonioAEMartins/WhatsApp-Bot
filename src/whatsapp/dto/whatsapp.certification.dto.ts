import { IsNotEmpty, IsString, IsEnum, IsOptional } from 'class-validator';

/**
 * Registration method enum for WhatsApp Business API account verification
 */
export enum RegistrationMethod {
  SMS = 'sms',
  VOICE = 'voice',
}

/**
 * DTO for requesting a registration code for WhatsApp Business API
 */
export class RequestRegistrationCodeDto {
  @IsNotEmpty()
  @IsString()
  cc: string; // Country code (numeric)

  @IsNotEmpty()
  @IsString()
  phone_number: string; // Phone number without country code

  @IsEnum(RegistrationMethod)
  method: RegistrationMethod; // Method to receive verification code (sms or voice)

  @IsNotEmpty()
  @IsString()
  cert: string; // Base64 encoded verified name certificate

  @IsOptional()
  @IsString()
  pin?: string; // 6-digit PIN if two-step verification is enabled
}

/**
 * DTO for verifying a WhatsApp Business API account with the received code
 */
export class VerifyAccountDto {
  @IsNotEmpty()
  @IsString()
  code: string; // Verification code received via SMS or voice call
}

/**
 * Response DTO for account registration initiation
 */
export class RegistrationResponseDto {
  account: Array<{
    vname: string; // Decoded verified name from the certificate
  }>;
  status?: string;
  message?: string;
}

/**
 * Response DTO for account verification completion
 */
export class VerificationResponseDto {
  status: string;
  message?: string;
  error?: string;
} 