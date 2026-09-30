import { createContext, useContext } from "react";

// same reason as renameContext: the card star reaches useClips without threading props
export type FavoriteFn = (names: string[], favorite: boolean) => void;

export const FavoriteContext = createContext<FavoriteFn | null>(null);

export function useFavorite(): FavoriteFn | null {
  return useContext(FavoriteContext);
}
