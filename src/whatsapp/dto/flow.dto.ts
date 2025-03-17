import { Expose } from 'class-transformer';
import { IsString, IsOptional } from 'class-validator';

export class FlowDataDto {
  @Expose()
  @IsString()
  @IsOptional()
  encrypted_flow_data?: string;

  @Expose()
  @IsString()
  @IsOptional()
  encrypted_aes_key?: string;

  @Expose()
  @IsString()
  @IsOptional()
  initial_vector?: string;
  
  // Fields for direct health check
  @Expose()
  @IsString()
  @IsOptional()
  version?: string;
  
  @Expose()
  @IsString()
  @IsOptional()
  action?: string;
} 