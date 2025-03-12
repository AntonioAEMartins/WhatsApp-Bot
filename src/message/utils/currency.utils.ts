// src/utils/currency.utils.ts
export function formatToBRL(value: number | string): string {
    const numericValue = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(numericValue)) {
        throw new Error('O valor fornecido não é um número válido.');
    }
    return numericValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
