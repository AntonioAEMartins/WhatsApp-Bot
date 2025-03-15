import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { 
  RequestRegistrationCodeDto, 
  VerifyAccountDto,
  RegistrationResponseDto,
  VerificationResponseDto,
  RegistrationMethod
} from './dto/whatsapp.certification.dto';

/**
 * Service for handling WhatsApp Business API certification and account verification
 */
@Injectable()
export class WhatsAppCertificationService {
  private readonly apiUrl: string;
  private readonly auth: { username: string; password: string };
  private readonly logger = new Logger(WhatsAppCertificationService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.apiUrl = this.configService.get<string>('WHATSAPP_ONPREM_API_URL');
    this.auth = {
      username: this.configService.get<string>('WHATSAPP_ADMIN_USERNAME'),
      password: this.configService.get<string>('WHATSAPP_ADMIN_PASSWORD'),
    };
  }

  /**
   * Request a registration code for a WhatsApp Business Account
   * @param requestDto Data for the registration request
   * @returns Registration response with decoded vname
   */
  async requestRegistrationCode(
    requestDto?: RequestRegistrationCodeDto,
  ): Promise<RegistrationResponseDto> {
    try {
      // If DTO is not provided, use environment variables
      const payload: RequestRegistrationCodeDto = requestDto || {
        cc: this.configService.get<string>('WHATSAPP_COUNTRY_CODE'),
        phone_number: this.configService.get<string>('WHATSAPP_PHONE_NUMBER'),
        method: RegistrationMethod.SMS,
        cert: this.configService.get<string>('WHATSAPP_VERIFIED_NAME_CERT'),
        pin: this.configService.get<string>('WHATSAPP_TWO_STEP_PIN'),
      };

      // Validate required fields
      if (!payload.cc || !payload.phone_number || !payload.cert) {
        throw new HttpException(
          'Missing required fields for WhatsApp certification',
          HttpStatus.BAD_REQUEST,
        );
      }

      const url = `${this.apiUrl}/v1/account`;
      this.logger.log(`Requesting WhatsApp certification code via ${payload.method} to +${payload.cc}${payload.phone_number}`);

      const response$ = this.httpService.post(url, payload, {
        auth: this.auth,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await lastValueFrom(response$);
      
      // Handle different response statuses
      switch (response.status) {
        case 201:
          return {
            account: [{ vname: 'Account already registered' }],
            status: 'ALREADY_REGISTERED',
            message: 'The account is already registered and no further action is needed',
          };
        case 202:
          this.logger.log(
            `Registration code requested successfully. Check ${payload.method} on +${payload.cc}${payload.phone_number}`,
          );
          return response.data;
        default:
          return response.data;
      }
    } catch (error) {
      this.logger.error(`Error requesting WhatsApp registration code: ${error.message}`);
      
      if (error.response?.data) {
        this.logger.error(`API response: ${JSON.stringify(error.response.data)}`);
        throw new HttpException(
          error.response.data || 'Failed to request WhatsApp registration code',
          error.response.status || HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      
      throw new HttpException(
        `Failed to request WhatsApp registration code: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Verify a WhatsApp Business Account with the received code
   * @param verifyDto The verification data with the code received via SMS or voice
   * @returns Verification response
   */
  async verifyAccount(verifyDto: VerifyAccountDto): Promise<VerificationResponseDto> {
    try {
      if (!verifyDto.code) {
        throw new HttpException(
          'Verification code is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const url = `${this.apiUrl}/v1/account/verify`;
      this.logger.log('Verifying WhatsApp Business Account');

      const response$ = this.httpService.post(
        url,
        { code: verifyDto.code },
        {
          auth: this.auth,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const response = await lastValueFrom(response$);
      
      this.logger.log('WhatsApp Business Account verification successful');
      return {
        status: 'SUCCESS',
        message: 'WhatsApp Business Account verified successfully',
      };
    } catch (error) {
      this.logger.error(`Error verifying WhatsApp Business Account: ${error.message}`);
      
      if (error.response?.data) {
        this.logger.error(`API response: ${JSON.stringify(error.response.data)}`);
        throw new HttpException(
          error.response.data || 'Failed to verify WhatsApp Business Account',
          error.response.status || HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      
      throw new HttpException(
        `Failed to verify WhatsApp Business Account: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
} 