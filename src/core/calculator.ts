import type { CalculateRule } from './types';

export interface CalculateOptions {
  autoCalculate: boolean;
  outputMode: 'result' | 'equation';
  rules: CalculateRule[];
}

export interface ParsedExpression {
  num1: number;
  operator: string;
  num2: number;
  originalText: string;
  cleanExpression: string;
}

export class Calculator {
  private static readonly OPERATORS = ['+', '-', '×', '*', '÷', '/', 'x', 'X'];
  private static readonly EQUALS_CHARS = ['=', '＝'];
  private static readonly QUESTION_CHARS = ['?', '？', '〇', 'o', 'O', '0'];
  private static readonly NOISE_CHARS = ['?', '？', '〇', ' ', '\t', '\n', '\r'];

  static parseExpression(text: string): ParsedExpression | null {
    const trimmed = text.trim();
    
    let cleanText = trimmed;
    for (const noise of this.NOISE_CHARS) {
      cleanText = cleanText.split(noise).join('');
    }

    const patterns = [
      /^(\d+(?:\.\d+)?)\s*([+\-×*÷/xX])\s*(\d+(?:\.\d+)?)\s*[=＝]?\s*\d*$/,
      /^(\d+(?:\.\d+)?)\s*([+\-×*÷/xX])\s*(\d+(?:\.\d+)?)\s*[=＝]$/,
      /^(\d+(?:\.\d+)?)\s*([+\-×*÷/xX])\s*(\d+(?:\.\d+)?)$/,
    ];

    for (const pattern of patterns) {
      const match = cleanText.match(pattern);
      if (match) {
        const num1 = parseFloat(match[1]);
        const operator = match[2];
        const num2 = parseFloat(match[3]);
        
        if (!isNaN(num1) && !isNaN(num2)) {
          return {
            num1,
            operator,
            num2,
            originalText: trimmed,
            cleanExpression: `${num1}${this.normalizeOperator(operator)}${num2}`,
          };
        }
      }
    }

    const altPattern = /^(\d+(?:\.\d+)?)\s*([+\-×*÷/xX])\s*(\d+(?:\.\d+)?)\s*[=＝]\s*(\d+)$/;
    const altMatch = trimmed.match(altPattern);
    if (altMatch) {
      const num1 = parseFloat(altMatch[1]);
      const operator = altMatch[2];
      const num2 = parseFloat(altMatch[3]);
      const givenResult = parseFloat(altMatch[4]);
      
      if (!isNaN(num1) && !isNaN(num2)) {
        const correctResult = this.compute(num1, operator, num2);
        if (correctResult !== null && Math.abs(correctResult - givenResult) > 0.001) {
          return {
            num1,
            operator,
            num2,
            originalText: trimmed,
            cleanExpression: `${num1}${this.normalizeOperator(operator)}${num2}`,
          };
        }
      }
    }

    return null;
  }

  private static normalizeOperator(op: string): string {
    switch (op) {
      case 'x':
      case 'X':
      case '*':
        return '×';
      case '/':
        return '÷';
      default:
        return op;
    }
  }

  private static compute(num1: number, operator: string, num2: number): number | null {
    switch (operator) {
      case '+':
        return num1 + num2;
      case '-':
        return num1 - num2;
      case '*':
      case '×':
      case 'x':
      case 'X':
        return num1 * num2;
      case '/':
      case '÷':
        if (num2 === 0) return null;
        return num1 / num2;
      default:
        return null;
    }
  }

  static calculate(expression: ParsedExpression): number | null {
    return this.compute(expression.num1, expression.operator, expression.num2);
  }

  static formatResult(result: number): string {
    if (Number.isInteger(result)) {
      return String(result);
    }
    const formatted = result.toFixed(2);
    return formatted.replace(/\.?0+$/, '');
  }

  static formatEquation(expression: ParsedExpression, result: number): string {
    const op = this.normalizeOperator(expression.operator);
    return `${expression.num1}${op}${expression.num2}=${this.formatResult(result)}`;
  }

  static matchesPattern(hostname: string, pattern: string, matchType: 'wildcard' | 'regex'): boolean {
    try {
      if (matchType === 'regex') {
        const regex = new RegExp(pattern, 'i');
        return regex.test(hostname);
      } else {
        const regexPattern = '^' + pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')
          + '$';
        const regex = new RegExp(regexPattern, 'i');
        return regex.test(hostname);
      }
    } catch {
      return false;
    }
  }

  static getOutputModeForHostname(hostname: string, rules: CalculateRule[], defaultMode: 'result' | 'equation'): 'result' | 'equation' {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (this.matchesPattern(hostname, rule.pattern, rule.matchType)) {
        return rule.outputMode;
      }
    }
    return defaultMode;
  }

  static shouldCalculateForHostname(hostname: string, rules: CalculateRule[]): boolean {
    if (!rules || rules.length === 0) return true;
    const enabledRules = rules.filter(r => r.enabled);
    if (enabledRules.length === 0) return true;
    for (const rule of enabledRules) {
      if (this.matchesPattern(hostname, rule.pattern, rule.matchType)) {
        return true;
      }
    }
    return false;
  }

  static processResult(
    text: string,
    options: CalculateOptions,
    hostname: string
  ): string {
    if (!options.autoCalculate) {
      return text;
    }

    if (options.rules && options.rules.length > 0) {
      if (!this.shouldCalculateForHostname(hostname, options.rules)) {
        return text;
      }
    }

    const expression = this.parseExpression(text);
    if (!expression) {
      return text;
    }

    const result = this.calculate(expression);
    if (result === null) {
      return text;
    }

    const outputMode = this.getOutputModeForHostname(hostname, options.rules, options.outputMode);
    
    if (outputMode === 'equation') {
      return this.formatEquation(expression, result);
    }
    return this.formatResult(result);
  }

  static isExpression(text: string): boolean {
    return this.parseExpression(text) !== null;
  }
}