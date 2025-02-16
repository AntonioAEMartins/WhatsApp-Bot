import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
  } from '@nestjs/common';
  import { Response } from 'express';
  
  interface ErrorResponse {
    msg: string;
    error: {
      status: number;
      message: string;
    };
  }
  
  @Catch()
  export class GlobalHttpExceptionFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse<Response>();
      const request = ctx.getRequest<Request>();
  
      let status: number;
      let errorMessage: string;
  
      if (exception instanceof HttpException) {
        status = exception.getStatus();
        const res = exception.getResponse();
        errorMessage = typeof res === 'string' ? res : (res as any).message;
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        errorMessage = 'Internal server error';
      }
  
      const errorResponse: ErrorResponse = {
        msg: 'Error',
        error: {
          status,
          message: errorMessage,
        },
      };
  
      response.status(status).json(errorResponse);
    }
  }
  