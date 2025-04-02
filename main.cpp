include <iostream>
#include <string>
using namespace std;

int findTime(string conversation, char infectedCategory) {
    int time = 0;
    string new_conv;
    
    while (conversation.find(infectedCategory) != string::npos) {
        new_conv = "";
        int length = conversation.length();
        
        for (int i = 0; i < length; i++) {
            if (conversation[i] == infectedCategory)
                continue; // Skip the infected category
            if ((i > 0 && conversation[i - 1] == infectedCategory) || (i < length - 1 && conversation[i + 1] == infectedCategory))
                continue; // Skip categories adjacent to infected category
            new_conv += conversation[i];
        }
        
        if (new_conv == conversation)
            break; // No more categories were removed
        
        conversation = new_conv;
        time++;
    }
    
    return time;
}

int main() {
    cout << findTime("abcdaed", 'd') << endl; // Example input
    return 0;
}
