const SPECIAL_CHARS = [
  '\\',
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
  '>',
  '<',
  '&',
  '#',
  '+',
  '-',
  '=',
  '|',
  '{',
  '}',
  '.',
  '!'
];

const escapeMarkdown = (text) => {
  const regex = new RegExp(`[${SPECIAL_CHARS.map(char => `\\${char}`).join('')}]`, 'g');
  return text.replace(regex, char => `\\${char}`);
};

module.exports = escapeMarkdown;