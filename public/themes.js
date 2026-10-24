// One theme sets the board colors and the piece set together.
export const THEMES = {
  classic:  { name: 'Classic',  light: '#ebecd0', dark: '#739552', mark: 'rgba(255, 255, 51, 0.45)', pieces: 'cburnett' },
  walnut:   { name: 'Walnut',   light: '#f0d9b5', dark: '#b58863', mark: 'rgba(205, 210, 106, 0.6)', pieces: 'fantasy' },
  glacier:  { name: 'Glacier',  light: '#dee3e6', dark: '#8ca2ad', mark: 'rgba(130, 200, 255, 0.5)', pieces: 'chessnut' },
  midnight: { name: 'Midnight', light: '#c5ccd6', dark: '#75849a', mark: 'rgba(120, 170, 255, 0.5)', pieces: 'spatial' },
  rose:     { name: 'Rose',     light: '#f3e4e1', dark: '#c48b8b', mark: 'rgba(255, 220, 120, 0.55)', pieces: 'celtic' },
  pixel:    { name: 'Pixel',    light: '#c4cfa1', dark: '#6e8b4a', mark: 'rgba(255, 240, 120, 0.5)', pieces: 'rhosgfx' },
};

export const pieceUrl = (theme, color, type) => `/pieces/${THEMES[theme].pieces}/${color}${type.toUpperCase()}.svg`;
