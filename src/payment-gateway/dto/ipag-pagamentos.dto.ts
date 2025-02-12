import { isInteger } from "@langchain/core/dist/utils/fast-json-patch/src/helpers";
import { Type } from "class-transformer";
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, IsInt, Min, Max, IsBoolean, ValidateNested, Matches } from "class-validator";

export class AntiFraudDto {

    @IsOptional()
    @IsString()
    fingerprint: string;

    @IsOptional()
    @IsString()
    @MaxLength(30)
    provider: string;
}

export enum PaymentType {
    card = 'card',
    boleto = 'boleto',
    pix = 'pix'
}

export enum PaymentMethodCard {
    visa = 'visa',
    mastercard = 'mastercard',
    elo = 'elo',
    amex = 'amex',
    diners = 'diners',
    discover = 'discover',
    hipercard = 'hipercard',
    hiper = 'hiper',
    jcb = 'jcb',
    aura = 'aura',
    visaelectron = 'visaelectron',
    maestro = 'maestro',
}

export enum PaymentMethodPix {
    pix = 'pix',
}

export type PaymentMethodMethod =
    | { type: PaymentType.card, method: PaymentMethodCard }
    | { type: PaymentType.boleto, method: never } // Assuming no specific method for boleto
    | { type: PaymentType.pix, method: PaymentMethodPix };

export class CardDto {

    @MaxLength(50)
    @IsNotEmpty({ message: "holder is required" })
    @IsString()
    holder: string

    @IsNotEmpty({ message: "number is required" })
    @MaxLength(19)
    @IsString()
    number: string

    @IsNotEmpty({ message: "expiry_month is required" })
    @MaxLength(2)
    @IsString()
    expiry_month: string

    @IsNotEmpty({ message: "expiry_year is required" })
    @MaxLength(4)
    @IsString()
    expiry_year: string

    @IsNotEmpty({ message: "cvv is required" })
    @MaxLength(4)
    @IsString()
    cvv: string

    @IsOptional()
    @IsString()
    @MaxLength(36)
    token?: string

    @IsOptional()
    @IsBoolean()
    tokenize?: boolean
}

export class PaymentDto {
    @IsEnum(PaymentType)
    @IsNotEmpty()
    type: PaymentType;

    @IsNotEmpty()
    @MaxLength(20)
    method: PaymentMethodMethod['method'];

    constructor(type: PaymentType, method: PaymentMethodMethod['method']) {
        this.type = type;
        this.method = method;

        if (type === PaymentType.card && !(method in PaymentMethodCard)) {
            throw new Error("Invalid method for card payment type");
        }
        if (type === PaymentType.pix && method !== PaymentMethodPix.pix) {
            throw new Error("Invalid method for pix payment type");
        }
        if (type === PaymentType.boleto && method !== undefined) {
            throw new Error("Boleto payment type should not have a method");
        }
    }

    @IsNotEmpty()
    @IsInt()
    @Min(1)
    @Max(12)
    installments: number;

    @IsOptional()
    @IsBoolean()
    capture?: boolean

    @IsOptional()
    @IsBoolean()
    fraud_analysis?: boolean

    @IsOptional()
    @IsString()
    @MaxLength(16)
    softdescriptor: string

    @IsOptional()
    @IsBoolean()
    recurring?: boolean

    @IsOptional()
    @ValidateNested()
    @Type(() => CardDto)
    card?: CardDto

    @IsOptional()
    @IsInt()
    pix_expires_in?: number
}

export class BillingAddressDto {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    street?: string;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    number?: string;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    district?: string;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    complement?: string;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    city?: string;

    @IsOptional()
    @IsString()
    @MaxLength(2)
    state?: string;

    @IsOptional()
    @IsString()
    @MaxLength(2)
    country?: string;

    @IsOptional()
    @IsString()
    @MaxLength(8)
    zipcode?: string;
}

export class CustomerDto {
    @IsNotEmpty({ message: "name is required" })
    @IsString()
    @MaxLength(80)
    name: string

    @IsNotEmpty({ message: "cpf_cnpj is required" })
    @IsString()
    @MaxLength(14)
    cpf_cnpj: string

    @IsOptional()
    @IsString()
    @MaxLength(20)
    tax_id?: string

    @IsOptional()
    @IsString()
    @MaxLength(80)
    email?: string

    @IsOptional()
    @IsString()
    @MaxLength(11)
    phone?: string

    @IsOptional()
    @IsString()
    @MaxLength(10)
    @Matches(/^\d{1,2}\/\d{1,2}\/\d{4}$/, { message: "Birthdate must be in the format d/m/y" })
    birthdate?: string

    @IsOptional()
    @IsString()
    ip?: string

    @IsOptional()
    @ValidateNested()
    @Type(() => BillingAddressDto)
    billing_address?: BillingAddressDto
}

export class SplitRulesDto {
    @IsNotEmpty()
    @IsString()
    @MaxLength(50)
    seller_id: string;

    @IsOptional()
    @IsNumber()
    percentage?: number;

    @IsOptional()
    @IsNumber()
    amount?: number;

    @IsOptional()
    @IsBoolean()
    charge_processing_fee?: boolean = false;

    @IsOptional()
    @IsBoolean()
    hold_receivables?: boolean = false;
}

export class CreatePaymentDto {

    @IsOptional()
    @IsString()
    @MaxLength(36)
    merchant_id?: string;

    @IsOptional()
    @IsNumber()
    amount?: number;

    @IsOptional()
    @IsString()
    @MaxLength(16)
    order_id?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    callback_url?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    redirect_url?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => PaymentDto)
    payment?: PaymentDto

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomerDto)
    customer?: CustomerDto

    @IsOptional()
    @ValidateNested()
    @Type(() => SplitRulesDto)
    split_rules?: SplitRulesDto[];
}

export class UserPaymentCreditInfoDto {

    @IsNotEmpty({ message: "cardInfo is required" })
    @ValidateNested()
    @Type(() => CardDto)
    cardInfo: CardDto;

    @IsNotEmpty({ message: "customerInfo is required" })
    @ValidateNested()
    @Type(() => CustomerDto)
    customerInfo: CustomerDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => BillingAddressDto)
    billingAddress?: BillingAddressDto;

    @IsNotEmpty({ message: "saveCard is required" })
    @IsBoolean()
    saveCard: boolean;

    @IsNotEmpty({ message: "transactionId is required" })
    @IsString()
    transactionId: string;
}

export class UserPaymentPixInfoDto {
    @IsNotEmpty({ message: "transactionId is required" })
    @IsString()
    transactionId: string;

    @IsOptional()
    @IsNumber()
    pixExpiresIn?: number;

    @IsNotEmpty({ message: "customerInfo is required" })
    @ValidateNested()
    @Type(() => CustomerDto)
    customerInfo: CustomerDto;
}

export class CardInfoDto {
    @IsNotEmpty()
    @IsString()
    number: string;
}