import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AddressDto {
    @IsOptional()
    @IsString()
    @MaxLength(70)
    street?: string;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    number?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    district?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    complement?: string;

    @IsOptional()
    @IsString()
    @MaxLength(50)
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

export class OwnerDto {
    @IsOptional()
    @IsString()
    @MaxLength(80)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    email?: string;

    @IsOptional()
    @IsString()
    cpf?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsString()
    // Como o formato pode ser "Y-m-d" ou "d/m/Y", mantemos como string.
    birthdate?: string;
}

export class BankDto {
    @IsOptional()
    @IsString()
    @MaxLength(3)
    code?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4)
    agency?: string;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    account?: string;

    @IsOptional()
    @IsString()
    @IsIn(['checkings', 'savings', 'payment', 'salary'])
    type?: string;

    @IsOptional()
    @IsString()
    external_id?: string;
}

export class CreateSellerDto {
    @IsOptional()
    @IsBoolean()
    is_active?: boolean = true;

    @IsNotEmpty()
    @IsString()
    @MaxLength(50)
    login: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(20)
    password: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(100)
    name: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    business_name?: string;

    @IsNotEmpty()
    @IsString()
    // CPF ou CNPJ; você pode aplicar validação customizada se necessário.
    cpf_cnpj: string;

    @IsNotEmpty()
    @IsEmail()
    @MaxLength(50)
    email: string;

    @IsNotEmpty()
    @IsString()
    phone: string;

    @IsOptional()
    @IsString()
    // Como o campo pode ser utilizado para data de nascimento ou de abertura, mantém-se o formato string.
    birthdate?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    description?: string;

    @IsOptional()
    @Type(() => AddressDto)
    address?: AddressDto;

    @IsOptional()
    @Type(() => OwnerDto)
    owner?: OwnerDto;

    @IsOptional()
    @Type(() => BankDto)
    bank?: BankDto;
}

export class AddressEstablishmentDto {
    @IsNotEmpty()
    @IsString()
    @MaxLength(70)
    street: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(10)
    number: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(100)
    district: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(100)
    complement: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(50)
    city: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(2)
    state: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(8)
    zipcode: string;
}

export class OwnerEstablishmentDto {
    @IsOptional()
    @IsString()
    @MaxLength(80)
    name?: string;

    @IsOptional()
    @IsEmail()
    @MaxLength(50)
    email?: string;

    @IsOptional()
    @IsString()
    cpf?: string;

    @IsOptional()
    @IsString()
    phone?: string;
}

export enum BankAccountType {
    CHECKINGS = 'checkings',
    SAVINGS = 'savings',
    PAYMENT = 'payment',
    SALARY = 'salary',
}

export class BankEstablishmentDto {
    @IsOptional()
    @IsString()
    @MaxLength(3)
    code?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4)
    agency?: string;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    account?: string;

    @IsOptional()
    @IsString()
    @IsIn([BankAccountType.CHECKINGS, BankAccountType.SAVINGS, BankAccountType.PAYMENT, BankAccountType.SALARY])
    type?: string;

    @IsOptional()
    @IsString()
    external_id?: string;
}

export class CreateEstablishmentDto {
    @IsOptional()
    @IsBoolean()
    enable?: boolean = false;

    @IsNotEmpty()
    @IsString()
    @MaxLength(50)
    login: string;

    @IsNotEmpty()
    @IsString()
    @MaxLength(100)
    name: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    business_name?: string;

    @IsNotEmpty()
    @IsEmail()
    @MaxLength(50)
    email: string;

    @IsNotEmpty()
    @IsString()
    @MinLength(6)
    @MaxLength(20)
    password: string;

    @IsNotEmpty()
    @IsString()
    document: string;

    @IsNotEmpty()
    @IsString()
    phone: string;

    @IsNotEmpty()
    @Type(() => AddressEstablishmentDto)
    address: AddressEstablishmentDto;

    @IsOptional()
    @Type(() => OwnerEstablishmentDto)
    owner?: OwnerEstablishmentDto;

    @IsOptional()
    @Type(() => BankEstablishmentDto)
    bank?: BankEstablishmentDto;
}
