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
    const env = process.env.ENVIRONMENT;
    this.phoneNumberId = env === "demo" ? process.env.WHATSAPP_DEMO_PHONE_NUMBER_ID : (env === "homologation" || env === "development" ? process.env.WHATSAPP_TEST_PHONE_NUMBER_ID : process.env.WHATSAPP_PROD_PHONE_NUMBER_ID);
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
      recipient_type: 'individual',
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

      case 'interactive':
        if (!response.interactive) {
          throw new HttpException(
            'Dados interativos ausentes para mensagem do tipo interactive',
            HttpStatus.BAD_REQUEST
          );
        }

        body.type = 'interactive';

        // Check if this is a flow interactive message by looking at properties
        if (response.interactive.hasOwnProperty('type') && (response.interactive as any).type === 'flow') {
          // This is a flow interactive message
          this.logger.debug(`Sending Flow interactive message: ${JSON.stringify(response.interactive)}`);

          const flowInteractive = response.interactive as any;

          // Format according to WhatsApp API requirements for Flow messages
          body.interactive = {
            type: "flow",
            header: flowInteractive.header,
            body: flowInteractive.body,
            footer: flowInteractive.footer,
            action: {
              name: "flow",
              parameters: flowInteractive.action.parameters
            }
          };

          // Log the exact request body being sent
          this.logger.debug(`Final Flow message request body: ${JSON.stringify(body)}`);
        } else {
          // This is a button interactive message
          body.interactive = {
            type: 'button',
            body: {
              text: response.interactive.bodyText
            },
            action: {
              buttons: response.interactive.buttons.map(button => ({
                type: 'reply',
                reply: {
                  id: button.id,
                  title: button.title
                }
              }))
            }
          };

          // Add header if available
          if (response.interactive.headerType && response.interactive.headerContent) {
            body.interactive.header = {
              type: response.interactive.headerType
            };

            // Add the appropriate field based on header type
            switch (response.interactive.headerType) {
              case 'text':
                body.interactive.header.text = response.interactive.headerContent;
                break;
              case 'image':
                // Check if it's an ID or URL
                if (this.isHttpUrl(response.interactive.headerContent)) {
                  body.interactive.header.image = { link: response.interactive.headerContent };
                } else {
                  body.interactive.header.image = { id: response.interactive.headerContent };
                }
                break;
              case 'document':
                if (this.isHttpUrl(response.interactive.headerContent)) {
                  body.interactive.header.document = { link: response.interactive.headerContent };
                } else {
                  body.interactive.header.document = { id: response.interactive.headerContent };
                }
                break;
              case 'video':
                if (this.isHttpUrl(response.interactive.headerContent)) {
                  body.interactive.header.video = { link: response.interactive.headerContent };
                } else {
                  body.interactive.header.video = { id: response.interactive.headerContent };
                }
                break;
            }
          }

          // Add footer if available
          if (response.interactive.footerText) {
            body.interactive.footer = {
              text: response.interactive.footerText
            };
          }
        }
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

      // Log more detailed error information
      if (error?.response?.data) {
        this.logger.error(`WhatsApp API error response: ${JSON.stringify(error.response.data)}`);
      }

      if (error?.response?.status === 400) {
        this.logger.error(`WhatsApp API 400 Bad Request - Request body was: ${JSON.stringify(body)}`);
      }

      // Rethrow the error to allow proper handling upstream
      // throw new HttpException(
      // error?.response?.data || 'Erro ao enviar mensagem ao WhatsApp',
      // error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR
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

  /**
   * Creates an interactive button message structure
   * @param to Recipient's phone number
   * @param bodyText The main text of the message
   * @param buttons Array of buttons (up to 3)
   * @param options Optional parameters like header and footer
   * @returns A formatted ResponseStructureExtended object for interactive buttons
   */
  createInteractiveButtonMessage(
    to: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
    options?: {
      headerType?: 'text' | 'image' | 'document' | 'video';
      headerContent?: string;
      footerText?: string;
    }
  ): ResponseStructureExtended {
    if (buttons.length > 3) {
      this.logger.warn('WhatsApp only supports up to 3 buttons. Extra buttons will be ignored.');
      buttons = buttons.slice(0, 3);
    }

    // Validate button titles (max 20 chars)
    buttons.forEach(button => {
      if (button.title.length > 20) {
        this.logger.warn(`Button title too long (max 20 chars): "${button.title}" will be truncated`);
        button.title = button.title.substring(0, 20);
      }
    });

    // Validate body text (max 1024 chars)
    if (bodyText.length > 1024) {
      this.logger.warn('Body text exceeds maximum length (1024 chars) and will be truncated');
      bodyText = bodyText.substring(0, 1024);
    }

    // Validate footer text if present (max 60 chars)
    let footerText = options?.footerText;
    if (footerText && footerText.length > 60) {
      this.logger.warn('Footer text exceeds maximum length (60 chars) and will be truncated');
      footerText = footerText.substring(0, 60);
    }

    return {
      type: 'interactive',
      content: '', // Not used for interactive messages but required by interface
      caption: '', // Not used for interactive messages but required by interface
      to: to,
      reply: false,
      isError: false,
      interactive: {
        headerType: options?.headerType,
        headerContent: options?.headerContent,
        bodyText: bodyText,
        footerText: footerText,
        buttons: buttons
      }
    };
  }

  async registerNumber({
    messaging_product,
    pin,
    phone_number_id,
  }) {
    const url = `${this.graphApiUrl}/${phone_number_id}/register`;

    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    const body = {
      messaging_product,
      pin
    };

    try {
      const observableResult = this.httpService.post(url, body, { headers });
      const result = await lastValueFrom(observableResult);
      return result.data;
    } catch (error) {
      this.logger.error(`Erro ao registrar número: ${error?.message || error}`);
    }
  }

  async twoFactorAuthentication({
    phone_number_id,
    pin,
  }) {
    // Validate PIN is exactly 6 digits
    if (!pin || !/^\d{6}$/.test(pin)) {
      throw new Error('PIN must be exactly 6 digits');
    }

    const url = `${this.graphApiUrl}/${phone_number_id}`;

    this.logger.log(`Setting up two-factor authentication for phone number ID: ${phone_number_id}`);

    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    const body = {
      pin
    };

    try {
      const observableResult = this.httpService.post(url, body, { headers });
      const result = await lastValueFrom(observableResult);
      this.logger.log('Two-factor authentication setup successful');
      return result.data;
    } catch (error) {
      this.logger.error(`Error setting up two-factor authentication: ${error?.message || error}`);
      throw new Error(`Failed to set up two-factor authentication: ${error?.message || 'Unknown error'}`);
    }
  }

  async getPhoneNumberId() {
    const url = `${this.graphApiUrl}/1178033237374005/phone_numbers?access_token=${this.accessToken}`;
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    const resp$ = this.httpService.get(url, { headers });
    const resp = await lastValueFrom(resp$);
    return resp.data;
  }

  /**
   * Creates a Flow message structure
   * @param to Recipient's phone number
   * @param bodyText The main text of the message
   * @param flowParams Parameters specific to the flow
   * @param options Optional parameters like header and footer
   * @returns A formatted ResponseStructureExtended object for flow messages
   */
  createFlowMessage(
    to: string,
    bodyText: string,
    flowParams: {
      flowId?: string;
      flowName?: string;
      flowCta: string;
      flowToken?: string;
      flowAction?: 'navigate' | 'data_exchange';
      flowActionPayload?: {
        screen?: string;
        data?: any;
      };
      mode?: 'draft' | 'published';
    },
    options?: {
      headerType?: 'text' | 'image' | 'document' | 'video';
      headerContent?: string;
      footerText?: string;
    }
  ): ResponseStructureExtended {
    // Validate required parameters
    if (!flowParams.flowId && !flowParams.flowName) {
      this.logger.error('Either flowId or flowName is required for Flow messages');
      throw new HttpException(
        'Either flowId or flowName is required for Flow messages',
        HttpStatus.BAD_REQUEST
      );
    }

    // Validate CTA text length
    if (flowParams.flowCta && flowParams.flowCta.length > 30) {
      this.logger.warn('Flow CTA text exceeds recommended length (30 chars) and may be truncated');
    }

    // Validate body text (max 1024 chars)
    if (bodyText.length > 1024) {
      this.logger.warn('Body text exceeds maximum length (1024 chars) and will be truncated');
      bodyText = bodyText.substring(0, 1024);
    }

    // Validate footer text if present (max 60 chars)
    let footerText = options?.footerText;
    if (footerText && footerText.length > 60) {
      this.logger.warn('Footer text exceeds maximum length (60 chars) and will be truncated');
      footerText = footerText.substring(0, 60);
    }

    // Build flow parameters according to WhatsApp API documentation
    const flowParameters: any = {
      flow_message_version: '3',
      flow_cta: flowParams.flowCta
    };

    // Add either flow_id or flow_name (one is required)
    if (flowParams.flowId) {
      flowParameters.flow_id = flowParams.flowId;
    } else if (flowParams.flowName) {
      flowParameters.flow_name = flowParams.flowName;
    }

    // Add optional flow parameters
    if (flowParams.flowToken) {
      flowParameters.flow_token = flowParams.flowToken;
    }

    if (flowParams.mode) {
      flowParameters.mode = flowParams.mode;
    }

    if (flowParams.flowAction) {
      flowParameters.flow_action = flowParams.flowAction;

      // Add flow_action_payload if we have it and flow_action is specified
      if (flowParams.flowActionPayload) {
        flowParameters.flow_action_payload = flowParams.flowActionPayload;
      }
    }

    // Create the flow interactive message structure according to WhatsApp API docs
    const interactive: any = {
      type: 'flow',
      body: {
        text: bodyText
      },
      action: {
        name: 'flow',
        parameters: flowParameters
      }
    };

    // Add header if provided
    if (options?.headerType && options?.headerContent) {
      interactive.header = {
        type: options.headerType
      };

      switch (options.headerType) {
        case 'text':
          interactive.header.text = options.headerContent;
          break;
        case 'image':
          if (this.isHttpUrl(options.headerContent)) {
            interactive.header.image = { link: options.headerContent };
          } else {
            interactive.header.image = { id: options.headerContent };
          }
          break;
        case 'document':
          if (this.isHttpUrl(options.headerContent)) {
            interactive.header.document = { link: options.headerContent };
          } else {
            interactive.header.document = { id: options.headerContent };
          }
          break;
        case 'video':
          if (this.isHttpUrl(options.headerContent)) {
            interactive.header.video = { link: options.headerContent };
          } else {
            interactive.header.video = { id: options.headerContent };
          }
          break;
      }
    }

    // Add footer if provided
    if (footerText) {
      interactive.footer = {
        text: footerText
      };
    }

    // Log the final interactive payload for debugging
    this.logger.debug(`Flow message interactive: ${JSON.stringify(interactive)}`);

    return {
      type: 'interactive',
      content: '', // Not used for interactive messages but required by interface
      caption: '', // Not used for interactive messages but required by interface
      to: to,
      reply: false,
      isError: false,
      interactive: interactive as any // Cast to any to avoid type checking issues
    };
  }

  /**
   * Sends a flow message directly to a WhatsApp user
   * @param to Recipient's phone number
   * @param bodyText The main message text
   * @param flowId The unique ID of the Flow provided by WhatsApp
   * @param flowCta Text on the CTA button (e.g., "Book Now")
   * @param options Additional options for the flow message
   * @returns The WhatsApp API response
   */
  async sendFlowMessage(
    to: string,
    bodyText: string,
    flowId: string,
    flowCta: string,
    options?: {
      flowToken?: string;
      flowAction?: 'navigate' | 'data_exchange';
      flowActionPayload?: {
        screen?: string;
        data?: any;
      };
      mode?: 'draft' | 'published';
      headerType?: 'text' | 'image' | 'document' | 'video';
      headerContent?: string;
      footerText?: string;
    }
  ): Promise<any> {
    // Create the flow message structure
    const flowMessage = this.createFlowMessage(
      to,
      bodyText,
      {
        flowId,
        flowCta,
        flowToken: options?.flowToken,
        flowAction: options?.flowAction,
        flowActionPayload: options?.flowActionPayload,
        mode: options?.mode,
      },
      {
        headerType: options?.headerType,
        headerContent: options?.headerContent,
        footerText: options?.footerText,
      }
    );

    // Send the message
    return this.sendWhatsAppMessage(flowMessage);
  }

  /**
   * Sends a flow message using flow name instead of ID
   * @param to Recipient's phone number
   * @param bodyText The main message text
   * @param flowName The name of the Flow that you created
   * @param flowCta Text on the CTA button (e.g., "Book Now")
   * @param options Additional options for the flow message
   * @returns The WhatsApp API response
   */
  async sendFlowMessageByName(
    to: string,
    bodyText: string,
    flowName: string,
    flowCta: string,
    options?: {
      flowToken?: string;
      flowAction?: 'navigate' | 'data_exchange';
      flowActionPayload?: {
        screen?: string;
        data?: any;
      };
      mode?: 'draft' | 'published';
      headerType?: 'text' | 'image' | 'document' | 'video';
      headerContent?: string;
      footerText?: string;
    }
  ): Promise<any> {
    // Create the flow message structure
    const flowMessage = this.createFlowMessage(
      to,
      bodyText,
      {
        flowName,
        flowCta,
        flowToken: options?.flowToken,
        flowAction: options?.flowAction,
        flowActionPayload: options?.flowActionPayload,
        mode: options?.mode,
      },
      {
        headerType: options?.headerType,
        headerContent: options?.headerContent,
        footerText: options?.footerText,
      }
    );

    // Send the message
    return this.sendWhatsAppMessage(flowMessage);
  }

  /**
   * Send a flow message directly using the WhatsApp Graph API format
   * This method formats the message exactly according to the WhatsApp Flow API documentation
   * @param to Recipient's phone number
   * @param bodyText The main message text
   * @param flowCta Text for the CTA button
   * @param options Additional options
   * @returns WhatsApp API response
   */
  async sendFlowMessageDirectly(
    to: string,
    bodyText: string,
    flowCta: string,
    options: {
      flowId?: string;
      flowName?: string;
      headerType?: 'text' | 'image' | 'document' | 'video';
      headerContent?: string;
      footerText?: string;
      mode?: 'draft' | 'published';
    }
  ): Promise<any> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new HttpException('WhatsApp credentials not configured', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (!options.flowId && !options.flowName) {
      throw new HttpException('Either flowId or flowName must be provided', HttpStatus.BAD_REQUEST);
    }

    const url = `${this.graphApiUrl}/${this.phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    // Create the message body exactly as specified in the WhatsApp docs
    const messageBody: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: {
          text: bodyText
        },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_cta: flowCta
          }
        }
      }
    };

    // Add either flow_id or flow_name, but not both
    // Prefer flow_name over flow_id if both are provided
    if (options.flowName) {
      messageBody.interactive.action.parameters.flow_name = options.flowName;
    } else if (options.flowId) {
      messageBody.interactive.action.parameters.flow_id = options.flowId;
    }

    // Add mode if specified - published is the default according to WhatsApp docs
    if (options.mode) {
      messageBody.interactive.action.parameters.mode = options.mode;
    }

    // Add header if specified
    if (options.headerType && options.headerContent) {
      messageBody.interactive.header = {
        type: options.headerType
      };

      // Add the specific content based on header type
      switch (options.headerType) {
        case 'text':
          messageBody.interactive.header.text = options.headerContent;
          break;
        case 'image':
          if (this.isHttpUrl(options.headerContent)) {
            messageBody.interactive.header.image = { link: options.headerContent };
          } else {
            messageBody.interactive.header.image = { id: options.headerContent };
          }
          break;
        case 'document':
          if (this.isHttpUrl(options.headerContent)) {
            messageBody.interactive.header.document = { link: options.headerContent };
          } else {
            messageBody.interactive.header.document = { id: options.headerContent };
          }
          break;
        case 'video':
          if (this.isHttpUrl(options.headerContent)) {
            messageBody.interactive.header.video = { link: options.headerContent };
          } else {
            messageBody.interactive.header.video = { id: options.headerContent };
          }
          break;
      }
    }

    // Add footer if specified
    if (options.footerText) {
      messageBody.interactive.footer = {
        text: options.footerText
      };
    }

    this.logger.debug(`Sending Flow message directly: ${JSON.stringify(messageBody)}`);

    try {
      const observableResult = this.httpService.post(url, messageBody, { headers });
      const result = await lastValueFrom(observableResult);
      this.logger.debug(`Flow message sent successfully: ${JSON.stringify(result.data)}`);
      return result.data;
    } catch (error) {
      this.logger.error(`Error sending Flow message: ${error?.message || error}`);

      if (error?.response?.data) {
        this.logger.error(`WhatsApp API error response: ${JSON.stringify(error.response.data)}`);
      }

      throw new HttpException(
        error?.response?.data || 'Error sending Flow message',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
       * Sends a message to a specified WhatsApp group using the GoRelayBot
       * @param groupId The ID of the group to send the message to
       * @param messages Array of messages to send to the group
       */
  async sendGroupMessage(groupId: string, messages: ResponseStructureExtended[]): Promise<void> {
    try {
      const port = process.env.ENVIRONMENT === 'demo' ? '3110' : '3105';
      const url = `http://localhost:${port}/send-messages`;

      // Ensure all messages are sent to the correct group ID
      const groupMessages = messages.map(message => ({
        ...message,
        to: groupId
      }));

      console.log("groupMessages: ", groupMessages)

      // Send the request to the GoRelayBot
      const response = await lastValueFrom(
        this.httpService.post(url, groupMessages, {
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );

      this.logger.log(`Successfully sent ${messages.length} messages to group ${groupId} via GoRelayBot. Status: ${response.status}`);
    } catch (error) {
      this.logger.error(`Failed to send group messages to ${groupId} via GoRelayBot: ${error.message}`);
    }
  }

}


