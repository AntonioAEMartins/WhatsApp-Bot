import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class CheckoutCustomerAddressDto {
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
    @MaxLength(8)
    zipcode?: string;
}

export class CheckoutCustomerDto {
    @IsNotEmpty()
    @IsString()
    @MaxLength(80)
    name: string;

    @IsNotEmpty()
    @IsString()
    // CPF ou CNPJ – validação customizada pode ser adicionada se necessário
    tax_receipt: string;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    email?: string;

    @IsOptional()
    @IsString()
    // Pode ser validado quanto ao tamanho (10 ou 11 caracteres)
    phone?: string;

    @IsOptional()
    @IsString()
    // Formato: "Y-m-d" ou "d/m/Y" – para validação de formato, um validador customizado pode ser utilizado
    birthdate?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => CheckoutCustomerAddressDto)
    address?: CheckoutCustomerAddressDto;
}

export class CheckoutInstallmentSettingDto {
    @IsOptional()
    @IsNumber()
    max_installments?: number; // Valor entre 1 e 12

    @IsOptional()
    @IsNumber()
    min_installment_value?: number;

    @IsOptional()
    @IsNumber()
    interest?: number; // Juros em %

    @IsOptional()
    @IsNumber()
    interest_free_installments?: number; // Valor entre 1 e 12

    @IsOptional()
    @IsNumber()
    fixed_installment?: number; // Se definido, valor entre 1 e 12

    @IsOptional()
    @IsString()
    @IsIn(['all', 'creditcard', 'boleto', 'transfer', 'pix'])
    payment_method?: string;
}

export class CheckoutOrderDto {
    @IsOptional()
    @IsString()
    @MaxLength(16)
    order_id?: string;

    @IsNotEmpty()
    @IsNumber()
    amount: number;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    return_url?: string;

    @IsOptional()
    @IsString()
    return_type?: string; // Exemplo: "json"
}

export class CheckoutProductDto {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    name?: string;

    @IsOptional()
    @IsNumber()
    unit_price?: number;

    @IsOptional()
    @IsNumber()
    quantity?: number;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    sku?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    description?: string;
}

export class CheckoutSplitRuleDto {
    @IsNotEmpty()
    @IsString()
    @MaxLength(50)
    receiver: string;

    @IsOptional()
    @IsNumber()
    percentage?: number;

    @IsOptional()
    @IsNumber()
    amount?: number;

    @IsOptional()
    @IsBoolean()
    charge_processing_fee?: boolean = false;
}

export class CreateCheckoutDto {
    @IsNotEmpty()
    @ValidateNested()
    @Type(() => CheckoutCustomerDto)
    customer: CheckoutCustomerDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CheckoutInstallmentSettingDto)
    installment_setting?: CheckoutInstallmentSettingDto;

    @IsNotEmpty()
    @ValidateNested()
    @Type(() => CheckoutOrderDto)
    order: CheckoutOrderDto;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CheckoutProductDto)
    products?: CheckoutProductDto[];

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CheckoutSplitRuleDto)
    split_rules?: CheckoutSplitRuleDto[];

    @IsOptional()
    @IsString()
    @MaxLength(50)
    seller_id?: string;

    @IsOptional()
    @IsNumber()
    expires_in?: number; // Em minutos; padrão (se não informado) pode ser interpretado como 1440
}