import { Montserrat_400Regular } from '@expo-google-fonts/montserrat/400Regular';
import { Montserrat_500Medium } from '@expo-google-fonts/montserrat/500Medium';
import { Montserrat_600SemiBold } from '@expo-google-fonts/montserrat/600SemiBold';
import { Montserrat_700Bold } from '@expo-google-fonts/montserrat/700Bold';
import { PlayfairDisplay_500Medium } from '@expo-google-fonts/playfair-display/500Medium';
import { PlayfairDisplay_500Medium_Italic } from '@expo-google-fonts/playfair-display/500Medium_Italic';
import { PlayfairDisplay_700Bold } from '@expo-google-fonts/playfair-display/700Bold';

/**
 * Only the weights the website loads are bundled (Montserrat 400-700,
 * Playfair Display 500 and 500 italic). Importing from the package root would
 * pull in every weight and add several megabytes to the app.
 */
export const fontAssets = {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  PlayfairDisplay_500Medium,
  PlayfairDisplay_500Medium_Italic,
  // The service pages' page titles (h1) are Playfair 700 on the site.
  PlayfairDisplay_700Bold,
};
