import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import { Logger, ValidationPipe } from '@nestjs/common';
import { printConfig } from './print.config';
import * as bodyParser from 'body-parser';
import * as cors from 'cors';
import { GlobalHttpExceptionFilter } from './request/exception.filter';
dotenv.config()

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule);
  const port = process.env.ENVIRONMENT === 'demo' ? process.env.DEMO_PORT : 3005;

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );


  app.useGlobalFilters(new GlobalHttpExceptionFilter());

  // Enable CORS for https://pay.astra1.com.br/
  app.use(cors({
    // origin: 'https://pay.astra1.com.br',
    origin: '*',
  }));

  // Swagger setup
  const config = new DocumentBuilder()
    .setTitle('Your API title')
    .setDescription('API description')
    .setVersion('1.0')
    .addTag('your-tag')
    .build();

  app.use(
    bodyParser.json({
      verify: (req: any, res, buf, encoding) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
  );

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(port, '127.0.0.1');

  printConfig(port.toString());
}
bootstrap();
