import { IsString, IsNotEmpty, IsIn, ValidateNested } from "class-validator";
import { Expose } from "class-transformer";

// class Hub {
//   @IsString()
//   @IsNotEmpty()
//   @IsIn(['subscribe', 'unsubscribe'])
//   mode: string;
//   @IsString()
//   @IsNotEmpty()
//   verify_token: string;
//   @IsString()
//   @IsNotEmpty()
//   challenge: string;
// }

// export class WebhookVerificationDto {
//   @IsNotEmpty()
//   @ValidateNested()
//   @Type(() => Hub)
//   hub: Hub;
// }

export class WebhookVerificationDto {
  @Expose({ name: 'hub.mode' })
  @IsString()
  mode: string;

  @Expose({ name: 'hub.verify_token' })
  @IsString()
  verifyToken: string;

  @Expose({ name: 'hub.challenge' })
  @IsString()
  challenge: string;
}
