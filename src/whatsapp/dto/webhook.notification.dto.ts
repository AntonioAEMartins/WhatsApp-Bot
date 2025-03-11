import { Expose, Type } from 'class-transformer';
import { IsString, IsArray, ValidateNested, IsObject, Allow } from 'class-validator';

export class WebhookChangeDto {
  @Expose()
  @IsString()
  field: string;

  @Expose()
  @IsObject()
  @Allow()
  value: any;
}

export class WebhookEntryDto {
  @Expose()
  @IsString()
  id: string;

  @Expose()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookChangeDto)
  changes: WebhookChangeDto[];
}

export class WebhookNotificationDto {
  @Expose()
  @IsString()
  object: string;

  @Expose()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookEntryDto)
  entry: WebhookEntryDto[];
}
