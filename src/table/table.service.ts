import { Injectable } from '@nestjs/common';

@Injectable()
export class TableService {

    async orderTable(id: number): Promise<string> {

        const response = await fetch(`http://localhost:8000/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ table_id: id }),
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.text();
    }

}
