export class HolderDto {
    name: string;
    document: string;
}

export class BaseCardDto {
    userId: string;
    holder: HolderDto;
    brand: string;
    last4: string;
    token: string;
}

export class CardDto extends BaseCardDto {
    _id: string;
    createdAt: Date;
    updatedAt: Date;
}