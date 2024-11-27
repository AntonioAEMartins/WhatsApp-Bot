import { IsDate, IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";

export class UserDto {

    /* The _id field represent the phone number of the user */
    @IsString()
    @IsNotEmpty()
    @Matches(/^\d+$/, { message: '' })
    // _id: string;
    userId: string;

    @IsString()
    @IsOptional()
    country: string;

    @IsString()
    @IsOptional()
    name: string;

    @IsDate()
    @IsOptional()
    createdAt: Date;

    @IsDate()
    @IsOptional()
    updatedAt: Date;

    @IsDate()
    @IsOptional()
    lastConversation: Date;
}

export class CreateUserDto extends UserDto { }