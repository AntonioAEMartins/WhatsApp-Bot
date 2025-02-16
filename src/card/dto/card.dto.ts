import { PaymentMethodCard } from "src/payment-gateway/dto/ipag-pagamentos.dto";

export class HolderDto {
    name: string;
    document: string;
}

export class BaseCardDto {
    userId: string;
    holder: HolderDto;
    brand: PaymentMethodCard;
    last4: string;
    token: string;
    expiry_month: string;
    expiry_year: string;
}

export class CardDto extends BaseCardDto {
    _id: string;
    createdAt: Date;
    updatedAt: Date;
}