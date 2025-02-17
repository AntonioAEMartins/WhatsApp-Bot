import { Injectable } from '@nestjs/common';
import { createPdf } from '@saemhco/nestjs-html-pdf';
import * as path from 'path';
import * as fs from 'fs';
@Injectable()
export class GenReceiptService {

	private logoPath: string;
	constructor() {
		this.logoPath = path.join(process.cwd(), 'src', 'gen-receipt', 'templates', 'images', 'astra_logo.png');
		console.log(this.logoPath);
	}

	async generatePdf(data: ReceiptTemplateData): Promise<Buffer> {
		// Caminho absoluto para o arquivo de template HBS
		const filePath = path.join(process.cwd(), 'src', 'gen-receipt', 'templates', 'receipt.hbs');
		// Opções para a geração do PDF (ajuste conforme necessário)
		const options = {
			format: 'A5',
			printBackground: true,
			margin: {
				top: '0px',
				right: '0px',
				bottom: '0px',
				left: '0px',
			},
		};
		// Cria o PDF usando o template, as opções e os dados fornecidos
		const logoPath = path.join(process.cwd(), 'src', 'gen-receipt', 'templates', 'images', 'astra_logo.png');
		console.log(logoPath);
		const logoData = fs.readFileSync(logoPath);
		const base64Logo = `data:image/png;base64,${logoData.toString('base64')}`;

		return await createPdf(filePath, options, {
			...data,
			astraLogo: base64Logo,
		});
	}
}

// Interface com os dados que serão injetados no template
export interface ReceiptTemplateData {
	isPIX: boolean;
	statusTitle: string;
	amount: string;
	tableId: string;
	dateTime: string;
	statusLabel: string;
	cardLast4: string;
	whatsAppLink: string;
	privacyLink: string;
	termsLink: string;
}
