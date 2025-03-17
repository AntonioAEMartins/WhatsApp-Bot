import { Body, Controller, Post, HttpStatus, Logger } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WhatsAppCertificationService } from './whatsapp.certification.service';
import { 
  RequestRegistrationCodeDto, 
  VerifyAccountDto,
  RegistrationResponseDto,
  VerificationResponseDto 
} from './dto/whatsapp.certification.dto';

@ApiTags('whatsapp-certification')
@Controller('whatsapp/certification')
export class WhatsAppCertificationController {
  private readonly logger = new Logger(WhatsAppCertificationController.name);

  constructor(private readonly certificationService: WhatsAppCertificationService) {}

  @Post('request-code')
  @ApiOperation({ summary: 'Request a registration code for WhatsApp Business API' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Registration code requested successfully',
    type: RegistrationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request data',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Failed to request registration code',
  })
  async requestRegistrationCode(
    @Body() requestDto?: RequestRegistrationCodeDto,
  ): Promise<RegistrationResponseDto> {
    this.logger.log('Requesting WhatsApp Business API registration code');
    return this.certificationService.requestRegistrationCode(requestDto);
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify WhatsApp Business API account with received code' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Account verified successfully',
    type: VerificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid verification code',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Failed to verify account',
  })
  async verifyAccount(@Body() verifyDto: VerifyAccountDto): Promise<VerificationResponseDto> {
    this.logger.log('Verifying WhatsApp Business API account');
    return this.certificationService.verifyAccount(verifyDto);
  }

  @Post('register-with-env')
  @ApiOperation({ 
    summary: 'Request registration using environment variables',
    description: 'Uses the environment variables to request a WhatsApp registration code'
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Registration code requested successfully using environment variables',
    type: RegistrationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Failed to request registration code',
  })
  async registerWithEnv(): Promise<RegistrationResponseDto> {
    this.logger.log('Requesting WhatsApp registration code using environment variables');
    return this.certificationService.requestRegistrationCode();
  }
} 