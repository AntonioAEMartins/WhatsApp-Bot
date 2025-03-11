import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsString } from "class-validator";
import { ObjectId } from "mongodb";

export enum WhatsAppGroupType {
    PaymentProof = "payment_proof",
    Refunds = "refunds",
    Attendants = "attendants",
}

class GID {
    @IsString()
    server: string;

    @IsString()
    user: string;

    @IsString()
    _serialized: string;
}

export class WhatsAppParticipantsDTO {

    @IsString()
    id: string;

    @IsNumber()
    statusCode: number;

    @IsString()
    message: string;

    @IsBoolean()
    isGroupCreator: boolean;

    @IsBoolean()
    isInviteV4Sent: boolean;
}

export class WhatsAppGroupDTO {
    @IsString()
    _id: ObjectId;

    @IsString()
    title: string;

    @Type(() => GID)
    gid: GID;

    @Type(() => WhatsAppParticipantsDTO)
    participants: WhatsAppParticipantsDTO[];

    @IsEnum(WhatsAppGroupType)
    type: WhatsAppGroupType;
}

export class CreateWhatsAppGroupDTO {
    @IsString()
    @IsNotEmpty()
    title: string;

    @IsArray()
    @IsString({ each: true })
    participants: string[];

    @IsNotEmpty()
    @IsEnum(WhatsAppGroupType)
    type: WhatsAppGroupType;

}