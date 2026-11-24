import { Montserrat_400Regular } from '@expo-google-fonts/montserrat/400Regular';
import { Montserrat_500Medium } from '@expo-google-fonts/montserrat/500Medium';
import { Montserrat_600SemiBold } from '@expo-google-fonts/montserrat/600SemiBold';
import { Montserrat_700Bold } from '@expo-google-fonts/montserrat/700Bold';
import { Montserrat_800ExtraBold } from '@expo-google-fonts/montserrat/800ExtraBold';

/**
 * Only the weights the app uses are bundled: Montserrat 400-800. Importing from the package root would pull in
 * every weight and add several megabytes. Playfair Display (the website's serif) is no longer used by the app UI,
 * so it is no longer bundled; the splash shows the official logo image, which carries its own lettering.
 */
export const fontAssets = {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
};
