import { Expose, Type } from 'class-transformer';
import { IsString, IsArray, ValidateNested, IsObject, Allow, IsOptional } from 'class-validator';

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
export class NfmReplyDto {
  @Expose()
  @IsString()
  response_json: string;

  @Expose()
  @IsString()
  body: string;

  @Expose()
  @IsString()
  name: string;
}

export class InteractiveDto {
  @Expose()
  @IsString()
  type: string;

  @Expose()
  @IsOptional()
  @ValidateNested()
  @Type(() => NfmReplyDto)
  nfm_reply?: NfmReplyDto;
}

export class MessageDto {
  @Expose()
  @IsOptional()
  @IsObject()
  context?: any;

  @Expose()
  @IsString()
  from: string;

  @Expose()
  @IsString()
  id: string;

  @Expose()
  @IsString()
  timestamp: string;

  @Expose()
  @IsString()
  type: string;

  @Expose()
  @IsOptional()
  @ValidateNested()
  @Type(() => InteractiveDto)
  interactive?: InteractiveDto;
}

export class ContactDto {
  @Expose()
  @IsObject()
  profile: {
    name: string;
  };

  @Expose()
  @IsString()
  wa_id: string;
}

export class ValueDto {
  @Expose()
  @IsString()
  messaging_product: string;

  @Expose()
  @IsObject()
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };

  @Expose()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts: ContactDto[];

  @Expose()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages: MessageDto[];
}

export class FlowPaymentDataDto {
  @Expose()
  @IsString()
  @IsOptional()
  table_id?: string;

  @Expose()
  @IsString()
  @IsOptional()
  payment_value?: string;

  @Expose()
  @IsString()
  @IsOptional()
  transaction_id?: string;

  @Expose()
  @IsString()
  @IsOptional()
  holder_cpf?: string;

  @Expose()
  @IsString()
  @IsOptional()
  flow_token?: string;

  @Expose()
  @IsString()
  @IsOptional()
  card_number?: string;

  @Expose()
  @IsString()
  @IsOptional()
  holder_name?: string;

  @Expose()
  @IsArray()
  @IsOptional()
  save_card?: string[];

  @Expose()
  @IsString()
  @IsOptional()
  expiration_date?: string;

  @Expose()
  @IsString()
  @IsOptional()
  paymentMethod?: string;

  @Expose()
  @IsString()
  @IsOptional()
  cvv?: string;
}

export class WhatsAppWebhookDto {
  @Expose()
  @IsString()
  object: string;

  @Expose()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookEntryDto)
  entry: WebhookEntryDto[];
}
