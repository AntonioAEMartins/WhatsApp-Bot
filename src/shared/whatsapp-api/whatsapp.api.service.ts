import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { ResponseStructureExtended } from 'src/message/message.service';
import * as FormData from 'form-data';
import * as fs from 'fs';

@Injectable()
export class WhatsAppApiService {
  private readonly graphApiUrl: string;
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly logger = new Logger(WhatsAppApiService.name);

  constructor(private readonly httpService: HttpService) {
    this.graphApiUrl = process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com/v16.0';
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  /**
   * Sends a reaction emoji to a previous message
   * @param to WhatsApp user phone number
   * @param messageId The ID of the message to react to
   * @param emoji The emoji to react with, either as Unicode escape or emoji character
   * @returns API response
   */
  async sendMessageReaction(to: string, messageId: string, emoji: string): Promise<any> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new HttpException('Credenciais do WhatsApp não configuradas', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const url = `${this.graphApiUrl}/${this.phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'reaction',
      reaction: {
        message_id: messageId,
        emoji: emoji
      }
    };

    try {
      const observableResult = this.httpService.post(url, body, { headers });
      const result = await lastValueFrom(observableResult);
      return result.data;
    } catch (error) {
      this.logger.error(`Erro ao enviar reação para WhatsApp: ${error?.message || error}`);
      if (error?.response?.data) {
        this.logger.error(`Resposta da API: ${JSON.stringify(error.response.data)}`);
      }
      throw new HttpException(
        error?.response?.data || 'Erro ao enviar reação ao WhatsApp',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Marks a message as read/seen by sending a read receipt
   * @param messageId The ID of the message to mark as read
   * @returns API response
   */
  async markMessageAsSeen(messageId: string): Promise<any> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new HttpException('Credenciais do WhatsApp não configuradas', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const url = `${this.graphApiUrl}/${this.phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    const body = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    };

    try {
      const observableResult = this.httpService.post(url, body, { headers });
      const result = await lastValueFrom(observableResult);
      return result.data;
    } catch (error) {
      this.logger.error(`Erro ao marcar mensagem como lida: ${error?.message || error}`);
      if (error?.response?.data) {
        this.logger.error(`Resposta da API: ${JSON.stringify(error.response.data)}`);
      }
      // Not throwing an exception to avoid disrupting the normal flow if read receipt fails
      return { error: true, message: error?.message || 'Erro ao marcar mensagem como lida' };
    }
  }

  async sendWhatsAppMessage(response: ResponseStructureExtended): Promise<any> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new HttpException('Credenciais do WhatsApp não configuradas', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const url = `${this.graphApiUrl}/${this.phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    let body: any = {
      messaging_product: 'whatsapp',
      to: response.to
    };

    switch (response.type) {
      case 'text':
        body.type = 'text';
        body.text = { body: response.content };
        break;

      case 'image':
        body.type = 'image';
        body.image = { link: response.content, caption: response.caption || '' };
        break;

      case 'document':
        // Se o content for uma URL HTTP(S), usa link direto.
        // Caso contrário (ex.: base64), fazemos upload e enviamos via "document.id".
        if (this.isHttpUrl(response.content)) {
          body.type = 'document';
          body.document = {
            link: response.content,
            caption: response.caption || '',
            filename: 'Astra_Comprovante_Pagamento_Cris_Parrilla_' + this.formatCurrentDate()
          };
        } else {
          try {
            // Decodifica a string base64 para um Buffer
            const cleanedBase64 = response.content.replace(/^data:.*;base64,/, '');
            const fileBuffer = Buffer.from(cleanedBase64, 'base64');

            // Envia o buffer para o uploadMedia
            const mediaId = await this.uploadMedia(fileBuffer, 'application/pdf');

            body.type = 'document';
            body.document = {
              id: mediaId,
              caption: response.caption || '',
              filename: 'Astra_Comprovante_Pagamento_Cris_Parrilla_' + this.formatCurrentDate()
            };
          } catch (error) {
            this.logger.error(`Erro ao processar documento base64: ${error?.message || error}`);
            throw new HttpException(
              'Erro ao processar documento',
              HttpStatus.INTERNAL_SERVER_ERROR
            );
          }
        }
        break;

      default:
        throw new HttpException(
          `Tipo de mensagem não suportado: ${response.type}`,
          HttpStatus.BAD_REQUEST
        );
    }

    try {
      const observableResult = this.httpService.post(url, body, { headers });
      const result = await lastValueFrom(observableResult);
      return result.data;
    } catch (error) {
      this.logger.error(`Erro ao enviar mensagem para WhatsApp: ${error?.message || error}`);
      // throw new HttpException(
        // error?.response?.data || 'Erro ao enviar mensagem ao WhatsApp',
        // HttpStatus.INTERNAL_SERVER_ERROR
      // );
    }
  }

  async sendWhatsAppMessages(messages: ResponseStructureExtended[]): Promise<any[]> {
    const results: any[] = [];
    for (const msg of messages) {
      const result = await this.sendWhatsAppMessage(msg);
      await new Promise(resolve => setTimeout(resolve, 500));
      results.push(result);
    }
    return results;
  }

  async uploadMedia(fileBuffer: Buffer, mimeType: string): Promise<string> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new HttpException('Credenciais do WhatsApp não configuradas', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Create a temporary file
    const tempDir = './temp';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFilePath = `${tempDir}/temp_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.${this.getFileExtension(mimeType)}`;

    try {
      // Write buffer to temporary file
      fs.writeFileSync(tempFilePath, fileBuffer);
      this.logger.debug(`Temporary file created at: ${tempFilePath}`);

      const url = `${this.graphApiUrl}/${this.phoneNumberId}/media`;
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', fs.createReadStream(tempFilePath));
      formData.append('type', mimeType);

      const headers = {
        Authorization: `Bearer ${this.accessToken}`,
        ...formData.getHeaders?.()
      };

      this.logger.debug(`Uploading media to: ${url}`);
      const resp$ = this.httpService.post(url, formData, { headers });
      const resp = await lastValueFrom(resp$);

      // Clean up temporary file
      fs.unlinkSync(tempFilePath);
      this.logger.debug(`Media upload successful, received ID: ${resp.data.id}`);

      return resp.data.id;
    } catch (error) {
      // Clean up temporary file in case of error
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      this.logger.error(`Erro ao fazer upload de mídia: ${error?.message || error}`);
      if (error?.response?.data) {
        this.logger.error(`Resposta da API: ${JSON.stringify(error.response.data)}`);
      }
      throw new HttpException(error?.response?.data || 'Erro no upload de mídia', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private getFileExtension(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
    };

    return mimeToExt[mimeType] || 'bin';
  }

  async retrieveMediaUrl(mediaId: string): Promise<string> {
    if (!this.accessToken) {
      throw new HttpException('ACCESS_TOKEN não configurado', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const url = `${this.graphApiUrl}/${mediaId}`;
    try {
      const headers = { Authorization: `Bearer ${this.accessToken}` };
      const resp$ = this.httpService.get(url, { headers });
      const resp = await lastValueFrom(resp$);
      const ephemeralUrl = resp.data.url;
      if (!ephemeralUrl) {
        throw new Error('URL não encontrada na resposta do /MEDIA_ID');
      }
      return ephemeralUrl;
    } catch (error) {
      this.logger.error(`Erro ao obter URL da mídia: ${error?.message || error}`);
      throw new HttpException(
        error?.response?.data || 'Erro ao obter URL da mídia',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  async sendImageWithLink(to: string, link: string, caption?: string): Promise<any> {
    const url = `${this.graphApiUrl}/${this.phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: {
        link,
        caption: caption || ''
      }
    };
    try {
      const resp$ = this.httpService.post(url, body, { headers });
      const resp = await lastValueFrom(resp$);
      return resp.data;
    } catch (error) {
      this.logger.error(`Erro ao enviar imagem por link: ${error?.message || error}`);
      throw new HttpException(
        error?.response?.data || 'Erro ao enviar mensagem ao WhatsApp',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  async uploadAndSendImage(to: string, fileBuffer: Buffer, mimeType: string, caption?: string): Promise<any> {
    const mediaId = await this.uploadMedia(fileBuffer, mimeType);
    const ephemeralUrl = await this.retrieveMediaUrl(mediaId);
    return this.sendImageWithLink(to, ephemeralUrl, caption);
  }

  private isHttpUrl(content: string): boolean {
    try {
      const url = new URL(content);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async uploadDocumentBase64(base64String: string, mimeType = 'application/pdf'): Promise<string> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new HttpException('Credenciais do WhatsApp não configuradas', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Clean the base64 string and convert to buffer
    const cleanedBase64 = base64String.replace(/^data:.*;base64,/, '');
    const fileBuffer = Buffer.from(cleanedBase64, 'base64');

    // Use the existing uploadMedia method instead of duplicating logic
    return this.uploadMedia(fileBuffer, mimeType);
  }

  private formatCurrentDate(): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}_${month}_${year}`;
  }
}
