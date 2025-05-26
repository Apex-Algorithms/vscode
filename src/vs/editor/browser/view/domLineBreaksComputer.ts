/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from '../../../base/browser/trustedTypes.js';
import { CharCode } from '../../../base/common/charCode.js';
import * as strings from '../../../base/common/strings.js';
import { applyFontInfo } from '../config/domFontInfo.js';
import { EditorFontLigatures, EditorOption, WrappingIndent } from '../../common/config/editorOptions.js';
import { StringBuilder } from '../../common/core/stringBuilder.js';
import { InjectedTextOptions } from '../../common/model.js';
import { ILineBreaksComputer, ILineBreaksComputerFactory, ModelLineProjectionData } from '../../common/modelLineProjectionData.js';
import { LineInjectedText } from '../../common/textModelEvents.js';
import { IEditorConfiguration } from '../../common/config/editorConfiguration.js';
import { CharacterMapping, RenderLineInput, renderViewLine } from '../../common/viewLayout/viewLineRenderer.js';
import { LineDecoration } from '../../common/viewLayout/lineDecorations.js';
import { assertIsDefined } from '../../../base/common/types.js';
import { IViewLineTokens } from '../../common/tokens/lineTokens.js';

const ttPolicy = createTrustedTypesPolicy('domLineBreaksComputer', { createHTML: value => value });

export class DOMLineBreaksComputerFactory implements ILineBreaksComputerFactory {

	public static create(targetWindow: Window): DOMLineBreaksComputerFactory {
		return new DOMLineBreaksComputerFactory(new WeakRef(targetWindow));
	}

	constructor(private targetWindow: WeakRef<Window>) {
	}

	public createLineBreaksComputer(config: IEditorConfiguration, tabSize: number): ILineBreaksComputer {
		const requests: string[] = [];
		const injectedTexts: (LineInjectedText[] | null)[] = [];
		const linesDecorations: LineDecoration[][] = [];
		const linesTokens: IViewLineTokens[] = [];
		return {
			addRequest: (lineText: string, injectedText: LineInjectedText[] | null, lineDecorations: LineDecoration[], lineTokens: IViewLineTokens, previousLineBreakData: ModelLineProjectionData | null) => {
				requests.push(lineText);
				injectedTexts.push(injectedText);
				linesDecorations.push(lineDecorations);
				linesTokens.push(lineTokens);
			},
			finalize: () => {
				return createLineBreaks(config, assertIsDefined(this.targetWindow.deref()), requests, tabSize, injectedTexts, linesDecorations, linesTokens);
			}
		};
	}
}

function createLineBreaks(config: IEditorConfiguration, targetWindow: Window, requests: string[], tabSize: number, injectedTextsPerLine: (LineInjectedText[] | null)[], linesDecorations: LineDecoration[][], linesTokens: IViewLineTokens[]): (ModelLineProjectionData | null)[] {
	function createEmptyLineBreakWithPossiblyInjectedText(requestIdx: number): ModelLineProjectionData | null {
		const injectedTexts = injectedTextsPerLine[requestIdx];
		if (injectedTexts) {
			const lineText = LineInjectedText.applyInjectedText(requests[requestIdx], injectedTexts);

			const injectionOptions = injectedTexts.map(t => t.options);
			const injectionOffsets = injectedTexts.map(text => text.column - 1);

			// creating a `LineBreakData` with an invalid `breakOffsetsVisibleColumn` is OK
			// because `breakOffsetsVisibleColumn` will never be used because it contains injected text
			return new ModelLineProjectionData(injectionOffsets, injectionOptions, [lineText.length], [], 0);
		} else {
			return null;
		}
	}
	const options = config.options;
	const fontInfo = options.get(EditorOption.fontInfo);
	const wrappingIndent = options.get(EditorOption.wrappingIndent);
	const firstLineBreakColumn = options.get(EditorOption.wrappingInfo).wrappingColumn;
	const wordBreak = options.get(EditorOption.wordBreak);

	if (firstLineBreakColumn === -1) {
		const result: (ModelLineProjectionData | null)[] = [];
		for (let i = 0, len = requests.length; i < len; i++) {
			result[i] = createEmptyLineBreakWithPossiblyInjectedText(i);
		}
		return result;
	}

	const overallWidth = Math.round(firstLineBreakColumn * fontInfo.typicalHalfwidthCharacterWidth);
	const additionalIndent = (wrappingIndent === WrappingIndent.DeepIndent ? 2 : wrappingIndent === WrappingIndent.Indent ? 1 : 0);
	const additionalIndentSize = Math.round(tabSize * additionalIndent);

	const containerDomNode = document.createElement('div');
	containerDomNode.classList.add('dom-line-breaks-computer');
	applyFontInfo(containerDomNode, fontInfo);

	const sb = new StringBuilder(10000);
	const firstNonWhitespaceIndices: number[] = [];
	const wrappedTextIndentLengths: number[] = [];
	const renderLineContents: string[] = [];
	const characterMappings: CharacterMapping[] = [];
	for (let i = 0; i < requests.length; i++) {
		const lineContent = LineInjectedText.applyInjectedText(requests[i], injectedTextsPerLine[i]);

		let firstNonWhitespaceIndex = 0;
		let wrappedTextIndentLength = 0;
		let width = overallWidth;

		if (wrappingIndent !== WrappingIndent.None) {
			firstNonWhitespaceIndex = strings.firstNonWhitespaceIndex(lineContent);
			if (firstNonWhitespaceIndex === -1) {
				// all whitespace line
				firstNonWhitespaceIndex = 0;

			} else {
				// Track existing indent

				for (let i = 0; i < firstNonWhitespaceIndex; i++) {
					const charWidth = (
						lineContent.charCodeAt(i) === CharCode.Tab
							? (tabSize - (wrappedTextIndentLength % tabSize))
							: 1
					);
					wrappedTextIndentLength += charWidth;
				}

				const indentWidth = Math.ceil(fontInfo.spaceWidth * wrappedTextIndentLength);

				// Force sticking to beginning of line if no character would fit except for the indentation
				if (indentWidth + fontInfo.typicalFullwidthCharacterWidth > overallWidth) {
					firstNonWhitespaceIndex = 0;
					wrappedTextIndentLength = 0;
				} else {
					width = overallWidth - indentWidth;
				}
			}
		}

		const renderLineContent = lineContent.substr(firstNonWhitespaceIndex);
		const stopRenderingLineAfter = options.get(EditorOption.stopRenderingLineAfter);
		// Assume the largest case which is that the whitespaces are rendered
		const renderWhitespace = options.get(EditorOption.renderWhitespace);
		const renderControlCharacters = options.get(EditorOption.renderControlCharacters);
		const fontLigatures = options.get(EditorOption.fontLigatures);
		const useMonospaceOptimizations = fontInfo.isMonospace && !options.get(EditorOption.disableMonospaceOptimizations);
		const tokens = linesTokens[i];
		const lineDecorations = linesDecorations[i];
		const isBasicASCII = strings.isBasicASCII(renderLineContent);
		const containsRTL = strings.containsRTL(renderLineContent);
		const renderLineInput = new RenderLineInput(
			useMonospaceOptimizations,
			fontInfo.canUseHalfwidthRightwardsArrow,
			renderLineContent,
			false,
			isBasicASCII,
			containsRTL,
			0,
			tokens,
			lineDecorations,
			tabSize,
			firstLineBreakColumn,
			fontInfo.spaceWidth,
			fontInfo.middotWidth,
			fontInfo.wsmiddotWidth,
			stopRenderingLineAfter,
			renderWhitespace,
			renderControlCharacters,
			fontLigatures !== EditorFontLigatures.OFF,
			null
		);
		const lineHeight = 300;
		sb.appendString('<div style="height:');
		sb.appendString(String(lineHeight));
		sb.appendString('px;line-height:');
		sb.appendString(String(lineHeight));
		sb.appendString('px;width:');
		sb.appendString(String(width));
		sb.appendString('px;">');
		const renderedLineOutput = renderViewLine(renderLineInput, sb);
		sb.appendString('</div>');
		firstNonWhitespaceIndices[i] = firstNonWhitespaceIndex;
		wrappedTextIndentLengths[i] = wrappedTextIndentLength;
		renderLineContents[i] = renderLineContent;
		characterMappings[i] = renderedLineOutput.characterMapping;
	}
	const html = sb.build();
	const trustedhtml = ttPolicy?.createHTML(html) ?? html;
	containerDomNode.innerHTML = trustedhtml as string;

	containerDomNode.style.position = 'absolute';
	containerDomNode.style.top = '10000';
	if (wordBreak === 'keepAll') {
		// word-break: keep-all; overflow-wrap: anywhere
		containerDomNode.style.wordBreak = 'keep-all';
		containerDomNode.style.overflowWrap = 'anywhere';
	} else {
		// overflow-wrap: break-word
		containerDomNode.style.wordBreak = 'inherit';
		containerDomNode.style.overflowWrap = 'break-word';
	}
	targetWindow.document.body.appendChild(containerDomNode);

	const range = document.createRange();
	const lineDomNodes = Array.prototype.slice.call(containerDomNode.children, 0);

	const result: (ModelLineProjectionData | null)[] = [];
	for (let i = 0; i < requests.length; i++) {
		const lineDomNode = lineDomNodes[i];
		const characterMapping = characterMappings[i];
		const breakOffsets: number[] | null = readLineBreaks(range, lineDomNode, renderLineContents[i], characterMapping);
		if (breakOffsets === null) {
			result[i] = createEmptyLineBreakWithPossiblyInjectedText(i);
			continue;
		}

		const firstNonWhitespaceIndex = firstNonWhitespaceIndices[i];
		const wrappedTextIndentLength = wrappedTextIndentLengths[i] + additionalIndentSize;

		const breakOffsetsVisibleColumn: number[] = [];
		for (let j = 0, len = breakOffsets.length; j < len; j++) {
			breakOffsetsVisibleColumn[j] = characterMapping.getHorizontalOffset(breakOffsets[j] + 1);
		}

		if (firstNonWhitespaceIndex !== 0) {
			// All break offsets are relative to the renderLineContent, make them absolute again
			for (let j = 0, len = breakOffsets.length; j < len; j++) {
				breakOffsets[j] += firstNonWhitespaceIndex;
			}
		}

		let injectionOptions: InjectedTextOptions[] | null;
		let injectionOffsets: number[] | null;
		const curInjectedTexts = injectedTextsPerLine[i];
		if (curInjectedTexts) {
			injectionOptions = curInjectedTexts.map(t => t.options);
			injectionOffsets = curInjectedTexts.map(text => text.column - 1);
		} else {
			injectionOptions = null;
			injectionOffsets = null;
		}

		result[i] = new ModelLineProjectionData(injectionOffsets, injectionOptions, breakOffsets, breakOffsetsVisibleColumn, wrappedTextIndentLength);
	}

	containerDomNode.remove();
	return result;
}
function readLineBreaks(range: Range, lineDomNode: HTMLDivElement, lineContent: string, characterMapping: CharacterMapping): number[] | null {
	if (lineContent.length <= 1) {
		return null;
	}
	const outerSpan = <HTMLSpanElement>Array.prototype.slice.call(lineDomNode.children, 0)[0];

	const breakOffsets: number[] = [];
	try {
		discoverBreaks(range, outerSpan, characterMapping, 0, null, lineContent.length - 1, null, breakOffsets);
	} catch (err) {
		console.log(err);
		return null;
	}

	if (breakOffsets.length === 0) {
		return null;
	}

	breakOffsets.push(lineContent.length);
	return breakOffsets;
}

function discoverBreaks(range: Range, outerSpan: HTMLSpanElement, characterMapping: CharacterMapping, low: number, lowRects: DOMRectList | null, high: number, highRects: DOMRectList | null, result: number[]): void {
	if (low === high) {
		return;
	}

	const lowDomPosition1 = characterMapping.getDomPosition(low);
	const lowDomPosition2 = characterMapping.getDomPosition(low + 1);
	lowRects = lowRects || readClientRect(range, outerSpan, lowDomPosition1.charIndex, lowDomPosition1.partIndex, lowDomPosition2.charIndex, lowDomPosition2.partIndex);
	const highDomPosition1 = characterMapping.getDomPosition(high);
	const highDomPosition2 = characterMapping.getDomPosition(high + 1);
	highRects = highRects || readClientRect(range, outerSpan, highDomPosition1.charIndex, highDomPosition1.partIndex, highDomPosition2.charIndex, highDomPosition2.partIndex);

	if (Math.abs(lowRects[0].top - highRects[0].top) <= 300 / 2) {
		// same line
		return;
	}

	// there is at least one line break between these two offsets
	if (low + 1 === high) {
		// the two characters are adjacent, so the line break must be exactly between them
		result.push(high);
		return;
	}

	const mid = low + ((high - low) / 2) | 0;
	const midDomPosition1 = characterMapping.getDomPosition(mid);
	const midDomPosition2 = characterMapping.getDomPosition(mid + 1);
	const midRects = readClientRect(range, outerSpan, midDomPosition1.charIndex, midDomPosition1.partIndex, midDomPosition2.charIndex, midDomPosition2.partIndex);
	discoverBreaks(range, outerSpan, characterMapping, low, lowRects, mid, midRects, result);
	discoverBreaks(range, outerSpan, characterMapping, mid, midRects, high, highRects, result);
}

function readClientRect(range: Range, outerSpan: HTMLSpanElement, startCharacterOffset: number, startSpanOffset: number, endCharacterOffset: number, endSpanOffset: number): DOMRectList {
	const spans = <HTMLSpanElement[]>Array.prototype.slice.call(outerSpan.children, 0);
	range.setStart(spans[startSpanOffset].firstChild!, startCharacterOffset);
	range.setEnd(spans[endSpanOffset].firstChild!, endCharacterOffset);
	const clientRects = range.getClientRects();
	return clientRects;
}
